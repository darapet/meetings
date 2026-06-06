// ============================================================
//  WEBRTC.JS — Peer connections + audio pipeline + network
// ============================================================

class WebRTCManager {
  constructor(meetingId, userId, onRemoteStream, onPeerLeft, onNetworkQuality) {
    this.meetingId           = meetingId;
    this.userId              = userId;
    this.onRemoteStream      = onRemoteStream;
    this.onPeerLeft          = onPeerLeft;
    this.onNetworkQuality    = onNetworkQuality || (() => {});
    this.peers               = {};
    this.remoteStreams        = {};
    this._iceCandidateQueues = {};
    this._reconnectTimers    = {};
    this._networkTimers      = {};
    this._prevStats          = {};
    this._ownQualityTimer    = null;
    this.localStream         = null;
    this.screenStream        = null;
    this._activeVideoTrack   = null;
    this.audioProcessor      = null;
    this.presenceRef         = db.ref(`presence/${meetingId}/${userId}`);
  }

  // ── Local media ────────────────────────────────────────────
  async getLocalStream(videoEnabled = true, audioEnabled = true) {
    const audioConstraints = audioEnabled ? {
      echoCancellation:         { exact: true },
      noiseSuppression:         { exact: true },
      autoGainControl:          { exact: true },
      channelCount:             1,
      sampleRate:               48000,
      sampleSize:               16,
      latency:                  0,
      googEchoCancellation:     true,
      googEchoCancellation2:    true,
      googNoiseSuppression:     true,
      googNoiseSuppression2:    true,
      googAutoGainControl:      true,
      googAutoGainControl2:     true,
      googHighpassFilter:       true,
      googTypingNoiseDetection: true,
      googNoiseReduction:       true,
      googBeamforming:          true,
    } : false;

    let raw;
    try {
      raw = await navigator.mediaDevices.getUserMedia({
        video: videoEnabled ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false,
        audio: audioConstraints
      });
    } catch (_) {
      raw = await navigator.mediaDevices.getUserMedia({
        video: videoEnabled ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
        audio: audioEnabled ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } : false
      });
    }

    if (audioEnabled) {
      try {
        this.audioProcessor = new AudioProcessor();
        this.localStream    = await this.audioProcessor.process(raw);
      } catch (e) {
        console.warn("AudioProcessor unavailable:", e.message);
        this.localStream = raw;
      }
    } else {
      this.localStream = raw;
    }
    return this.localStream;
  }

  // ── Join room ─────────────────────────────────────────────
  async joinRoom() {
    this.presenceRef.set({
      userId:      this.userId,
      displayName: getCurrentUser().displayName || "Anonymous",
      photoURL:    getCurrentUser().photoURL    || "",
      joinedAt:    firebase.database.ServerValue.TIMESTAMP,
      audio:       true,
      video:       true,
      networkQuality: "good"
    });
    this.presenceRef.onDisconnect().remove();

    const presRef = db.ref(`presence/${this.meetingId}`);
    presRef.on("child_added",   snap => {
      const peerId = snap.key;
      if (peerId === this.userId) return;
      this._createPeerConnection(peerId, this.userId > peerId);
    });
    presRef.on("child_removed", snap => this._handlePeerLeft(snap.key));

    const sigRef = db.ref(`signals/${this.meetingId}/${this.userId}`);
    sigRef.on("child_added", async snap => {
      const { from, type, payload } = snap.val();
      await this._handleSignal(from, type, payload);
      snap.ref.remove();
    });

    // Monitor own upload quality every 4s
    this._ownQualityTimer = setInterval(() => this._measureOwnQuality(), 4000);
  }

  // ── Peer connection ────────────────────────────────────────
  async _createPeerConnection(peerId, isCaller) {
    if (this.peers[peerId]) return this.peers[peerId];
    const pc = new RTCPeerConnection(ICE_SERVERS);
    this.peers[peerId] = pc;
    this._iceCandidateQueues[peerId] = [];
    this._prevStats[peerId]          = {};

    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => pc.addTrack(t, this.localStream));
      const vt = this._activeVideoTrack || this.localStream.getVideoTracks()[0];
      if (vt) pc.addTrack(vt, this.localStream);
    }

    const remoteStream = new MediaStream();
    this.remoteStreams[peerId] = remoteStream;

    pc.ontrack = evt => {
      const track = evt.track;
      // Remove stale tracks of same kind so screen-share replacement shows immediately
      remoteStream.getTracks()
        .filter(t => t.kind === track.kind && t.id !== track.id)
        .forEach(t => remoteStream.removeTrack(t));
      if (!remoteStream.getTracks().find(t => t.id === track.id)) remoteStream.addTrack(track);
      this.onRemoteStream(peerId, remoteStream);
      track.onunmute = () => this.onRemoteStream(peerId, remoteStream);
    };

    pc.onicecandidate = evt => {
      if (evt.candidate) this._sendSignal(peerId, "ice", evt.candidate.toJSON());
    };

    // ── ICE state → auto reconnect ─────────────────────────
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;

      if (st === "disconnected") {
        // Notify UI immediately
        this.onNetworkQuality(peerId, "reconnecting", null);
        // Try ice restart after 4 s if still disconnected
        clearTimeout(this._reconnectTimers[peerId]);
        this._reconnectTimers[peerId] = setTimeout(() => {
          if (this.peers[peerId]?.iceConnectionState === "disconnected") {
            try { this.peers[peerId].restartIce(); } catch(_) {}
          }
        }, 4000);
      } else if (st === "failed") {
        this.onNetworkQuality(peerId, "reconnecting", null);
        clearTimeout(this._reconnectTimers[peerId]);
        // Wait a moment then hard-reconnect
        this._reconnectTimers[peerId] = setTimeout(() => this._reconnectPeer(peerId), 2000);
      } else if (st === "connected" || st === "completed") {
        clearTimeout(this._reconnectTimers[peerId]);
        this.onNetworkQuality(peerId, "good", null);
        this._startNetworkMonitor(peerId);
      } else if (st === "closed") {
        this._handlePeerLeft(peerId);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        clearTimeout(this._reconnectTimers[peerId]);
        this._reconnectTimers[peerId] = setTimeout(() => this._reconnectPeer(peerId), 1000);
      }
    };

    if (isCaller) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      this._sendSignal(peerId, "offer", { sdp: offer.sdp, type: offer.type });
    }
    return pc;
  }

  // ── Hard reconnect (ICE failed with no recovery) ──────────
  async _reconnectPeer(peerId) {
    if (!this.peers[peerId]) return;
    const old = this.peers[peerId];
    try { old.close(); } catch(_) {}
    delete this.peers[peerId];
    delete this.remoteStreams[peerId];
    delete this._iceCandidateQueues[peerId];
    clearTimeout(this._networkTimers[peerId]);
    this.onNetworkQuality(peerId, "reconnecting", null);
    // Re-initiate — caller by userId comparison
    try { await this._createPeerConnection(peerId, this.userId > peerId); } catch(_) {}
  }

  // ── getStats network quality polling ─────────────────────
  _startNetworkMonitor(peerId) {
    clearTimeout(this._networkTimers[peerId]);
    const poll = async () => {
      const pc = this.peers[peerId];
      if (!pc) return;
      try {
        const stats  = await pc.getStats();
        let rtt      = null;
        let lossRate = null;
        const prev   = this._prevStats[peerId] || {};

        stats.forEach(r => {
          // Round-trip time from nominated candidate pair
          if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated) {
            if (r.currentRoundTripTime != null) rtt = r.currentRoundTripTime * 1000;
          }
          // Packet loss from inbound audio
          if (r.type === "inbound-rtp" && r.kind === "audio") {
            const p = prev[r.id] || {};
            const lostDelta = (r.packetsLost     || 0) - (p.packetsLost     || 0);
            const recvDelta = (r.packetsReceived || 0) - (p.packetsReceived || 0);
            if (recvDelta + lostDelta > 5) lossRate = lostDelta / (recvDelta + lostDelta) * 100;
            prev[r.id] = r;
          }
        });

        this._prevStats[peerId] = prev;

        let quality = "good";
        if      (rtt !== null && (rtt > 350 || lossRate > 12)) quality = "poor";
        else if (rtt !== null && (rtt > 160 || lossRate >  4)) quality = "fair";

        this.onNetworkQuality(peerId, quality, { rtt: Math.round(rtt || 0), loss: Math.round(lossRate || 0) });
      } catch (_) {}
      this._networkTimers[peerId] = setTimeout(poll, 3500);
    };
    this._networkTimers[peerId] = setTimeout(poll, 2000);
  }

  // ── Own upload quality → written to own presence ──────────
  async _measureOwnQuality() {
    const pcs = Object.values(this.peers);
    if (!pcs.length) return;
    const results = await Promise.all(pcs.map(async pc => {
      try {
        const stats = await pc.getStats();
        let rtt = null;
        stats.forEach(r => {
          if (r.type === "candidate-pair" && r.nominated && r.currentRoundTripTime != null)
            rtt = r.currentRoundTripTime * 1000;
        });
        return rtt;
      } catch (_) { return null; }
    }));
    const rtts   = results.filter(r => r !== null);
    if (!rtts.length) return;
    const avgRtt = rtts.reduce((a, b) => a + b, 0) / rtts.length;
    const quality = avgRtt > 350 ? "poor" : avgRtt > 160 ? "fair" : "good";
    // Write own quality to presence so remote participants see it on our tile
    this.presenceRef.update({ networkQuality: quality }).catch(() => {});
    // Also fire callback for own tile (peerId = own userId)
    this.onNetworkQuality(this.userId, quality, { rtt: Math.round(avgRtt) });
  }

  async _handleSignal(peerId, type, payload) {
    if (type === "offer") {
      let pc = this.peers[peerId];
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(payload));
          await this._drainIceCandidateQueue(peerId);
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          this._sendSignal(peerId, "answer", { sdp: ans.sdp, type: ans.type });
          // After renegotiation (e.g. screen share start/stop via replaceTrack),
          // ontrack does NOT fire again — so we must manually sync remoteStream
          // with the current live receiver tracks, otherwise the video stays frozen.
          const remoteStream = this.remoteStreams[peerId];
          if (remoteStream) {
            pc.getReceivers().forEach(receiver => {
              const t = receiver.track;
              if (!t) return;
              // Drop any ended tracks of the same kind
              remoteStream.getTracks()
                .filter(existing => existing.kind === t.kind && existing.id !== t.id)
                .forEach(stale => remoteStream.removeTrack(stale));
              // Add the live receiver track if not already present
              if (!remoteStream.getTracks().find(existing => existing.id === t.id)) {
                remoteStream.addTrack(t);
              }
            });
            this.onRemoteStream(peerId, remoteStream);
          }
        } catch(e) { console.error("Re-offer:", e); }
        return;
      }
      pc = await this._createPeerConnection(peerId, false);
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      await this._drainIceCandidateQueue(peerId);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      this._sendSignal(peerId, "answer", { sdp: ans.sdp, type: ans.type });
    } else if (type === "answer") {
      const pc = this.peers[peerId];
      if (pc && pc.signalingState !== "stable") {
        try { await pc.setRemoteDescription(new RTCSessionDescription(payload)); await this._drainIceCandidateQueue(peerId); } catch(e) { console.error("Answer:", e); }
      }
    } else if (type === "ice") {
      const pc = this.peers[peerId];
      if (pc && pc.remoteDescription?.type) {
        try { await pc.addIceCandidate(new RTCIceCandidate(payload)); } catch(_) {}
      } else {
        if (!this._iceCandidateQueues[peerId]) this._iceCandidateQueues[peerId] = [];
        this._iceCandidateQueues[peerId].push(payload);
      }
    }
  }

  async _drainIceCandidateQueue(peerId) {
    const q = this._iceCandidateQueues[peerId] || [];
    const pc = this.peers[peerId];
    if (!pc || !q.length) return;
    for (const c of q) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(_) {} }
    this._iceCandidateQueues[peerId] = [];
  }

  _sendSignal(t, type, payload) {
    db.ref(`signals/${this.meetingId}/${t}`).push({ from: this.userId, type, payload });
  }

  _handlePeerLeft(peerId) {
    clearTimeout(this._reconnectTimers[peerId]);
    clearTimeout(this._networkTimers[peerId]);
    if (this.peers[peerId]) {
      try { this.peers[peerId].close(); } catch(_) {}
      delete this.peers[peerId]; delete this.remoteStreams[peerId];
      delete this._iceCandidateQueues[peerId]; delete this._prevStats[peerId];
      this.onPeerLeft(peerId);
    }
  }

  setAudioEnabled(enabled) {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach(t => t.enabled = enabled);
    if (this.audioProcessor) this.audioProcessor.setInputEnabled(enabled);
    this.presenceRef.update({ audio: enabled }).catch(() => {});
  }

  setVideoEnabled(enabled) {
    if (!this.localStream) return;
    this.localStream.getVideoTracks().forEach(t => t.enabled = enabled);
    this.presenceRef.update({ video: enabled }).catch(() => {});
  }

  async startScreenShare(onEnd) {
    this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: "always" }, audio: true });
    const screenTrack = this.screenStream.getVideoTracks()[0];
    this._activeVideoTrack = screenTrack;
    for (const [peerId, pc] of Object.entries(this.peers)) {
      const sender = pc.getSenders().find(s => s.track?.kind === "video");
      if (sender) {
        await sender.replaceTrack(screenTrack);
        try { const o = await pc.createOffer(); await pc.setLocalDescription(o); this._sendSignal(peerId, "offer", { sdp: o.sdp, type: o.type }); } catch(_) {}
      }
    }
    screenTrack.onended = () => this.stopScreenShare(onEnd);
    this.presenceRef.update({ screenSharing: true }).catch(() => {});
    return this.screenStream;
  }

  async stopScreenShare(callback) {
    this._activeVideoTrack = null;
    if (this.screenStream) { this.screenStream.getTracks().forEach(t => t.stop()); this.screenStream = null; }
    const camTrack = this.localStream?.getVideoTracks()[0];
    if (camTrack) {
      for (const [peerId, pc] of Object.entries(this.peers)) {
        const sender = pc.getSenders().find(s => s.track?.kind === "video");
        if (sender) {
          await sender.replaceTrack(camTrack);
          try { const o = await pc.createOffer(); await pc.setLocalDescription(o); this._sendSignal(peerId, "offer", { sdp: o.sdp, type: o.type }); } catch(_) {}
        }
      }
    }
    this.presenceRef.update({ screenSharing: false }).catch(() => {});
    if (callback) callback();
  }

  async leave() {
    clearInterval(this._ownQualityTimer);
    this.presenceRef.remove();
    Object.keys(this.peers).forEach(id => {
      clearTimeout(this._reconnectTimers[id]);
      clearTimeout(this._networkTimers[id]);
    });
    Object.values(this.peers).forEach(pc => { try { pc.close(); } catch(_) {} });
    this.peers = {}; this.remoteStreams = {}; this._iceCandidateQueues = {};
    if (this.localStream)    this.localStream.getTracks().forEach(t => t.stop());
    if (this.screenStream)   this.screenStream.getTracks().forEach(t => t.stop());
    if (this.audioProcessor) this.audioProcessor.destroy();
    db.ref(`signals/${this.meetingId}/${this.userId}`).remove();
  }
}
