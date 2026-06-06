// ============================================================
//  WEBRTC.JS — Peer connections + professional audio pipeline
// ============================================================

class WebRTCManager {
  constructor(meetingId, userId, onRemoteStream, onPeerLeft) {
    this.meetingId            = meetingId;
    this.userId               = userId;
    this.onRemoteStream       = onRemoteStream;
    this.onPeerLeft           = onPeerLeft;
    this.peers                = {};
    this.remoteStreams         = {};
    this._iceCandidateQueues  = {};
    this.localStream          = null;
    this.screenStream         = null;
    this._activeVideoTrack    = null;
    this.audioProcessor       = null;
    this.presenceRef          = db.ref(`presence/${meetingId}/${userId}`);
  }

  // ── Get local media + audio processing chain ──────────────
  async getLocalStream(videoEnabled = true, audioEnabled = true) {
    // Force echo cancellation (exact = required, not a preference)
    // This is critical for two devices in the same room
    const audioConstraints = audioEnabled ? {
      echoCancellation:         { exact: true },
      noiseSuppression:         { exact: true },
      autoGainControl:          { exact: true },
      channelCount:             1,
      sampleRate:               48000,
      sampleSize:               16,
      latency:                  0,
      // Chrome/Edge advanced — suppresses room echo aggressively
      googEchoCancellation:     true,
      googEchoCancellation2:    true,
      googNoiseSuppression:     true,
      googNoiseSuppression2:    true,
      googAutoGainControl:      true,
      googAutoGainControl2:     true,
      googHighpassFilter:       true,
      googTypingNoiseDetection: true,
      googNoiseReduction:       true,
      googBeamforming:          true,  // focus on sound directly in front of mic
    } : false;

    let raw;
    try {
      raw = await navigator.mediaDevices.getUserMedia({
        video: videoEnabled
          ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }
          : false,
        audio: audioConstraints
      });
    } catch (err) {
      // If exact constraints fail, fall back to ideal
      try {
        raw = await navigator.mediaDevices.getUserMedia({
          video: videoEnabled
            ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }
            : false,
          audio: audioEnabled ? {
            echoCancellation: true, noiseSuppression: true, autoGainControl: true,
            channelCount: 1, sampleRate: 48000
          } : false
        });
      } catch (e2) {
        throw e2;
      }
    }

    if (audioEnabled) {
      try {
        this.audioProcessor = new AudioProcessor();
        this.localStream    = await this.audioProcessor.process(raw);
      } catch (e) {
        console.warn("AudioProcessor unavailable, using browser defaults:", e.message);
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
      photoURL:    getCurrentUser().photoURL || "",
      joinedAt:    firebase.database.ServerValue.TIMESTAMP,
      audio:       true,
      video:       true
    });
    this.presenceRef.onDisconnect().remove();

    const presRef = db.ref(`presence/${this.meetingId}`);
    presRef.on("child_added", snap => {
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
  }

  async _createPeerConnection(peerId, isCaller) {
    if (this.peers[peerId]) return this.peers[peerId];
    const pc = new RTCPeerConnection(ICE_SERVERS);
    this.peers[peerId] = pc;
    this._iceCandidateQueues[peerId] = [];

    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => pc.addTrack(t, this.localStream));
      const videoTrack = this._activeVideoTrack || (this.localStream.getVideoTracks()[0] || null);
      if (videoTrack) pc.addTrack(videoTrack, this.localStream);
    }

    const remoteStream = new MediaStream();
    this.remoteStreams[peerId] = remoteStream;

    pc.ontrack = evt => {
      const track = evt.track;
      if (!remoteStream.getTracks().find(t => t.id === track.id)) remoteStream.addTrack(track);
      this.onRemoteStream(peerId, remoteStream);
      track.onunmute = () => this.onRemoteStream(peerId, remoteStream);
    };

    pc.onicecandidate = evt => {
      if (evt.candidate) this._sendSignal(peerId, "ice", evt.candidate.toJSON());
    };

    pc.oniceconnectionstatechange = () => {
      if (["disconnected","failed","closed"].includes(pc.iceConnectionState)) this._handlePeerLeft(peerId);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") { try { pc.restartIce(); } catch(_) {} }
    };

    if (isCaller) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      this._sendSignal(peerId, "offer", { sdp: offer.sdp, type: offer.type });
    }
    return pc;
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
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(payload));
          await this._drainIceCandidateQueue(peerId);
        } catch(e) { console.error("Answer:", e); }
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
    if (this.peers[peerId]) {
      this.peers[peerId].close();
      delete this.peers[peerId]; delete this.remoteStreams[peerId]; delete this._iceCandidateQueues[peerId];
      this.onPeerLeft(peerId);
    }
  }

  // ── Mic toggle — also silences the audio processing chain ──
  setAudioEnabled(enabled) {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach(t => t.enabled = enabled);
    // KEY FIX: bypass the audio processor chain when muted
    // Without this, ScriptProcessor continues running and gate shows activity
    if (this.audioProcessor) this.audioProcessor.setInputEnabled(enabled);
    this.presenceRef.update({ audio: enabled }).catch(() => {});
  }

  setVideoEnabled(enabled) {
    if (!this.localStream) return;
    this.localStream.getVideoTracks().forEach(t => t.enabled = enabled);
    this.presenceRef.update({ video: enabled }).catch(() => {});
  }

  // ── Screen share ──────────────────────────────────────────
  async startScreenShare(onEnd) {
    try {
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
    } catch (err) { throw err; }
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
    this.presenceRef.remove();
    Object.values(this.peers).forEach(pc => pc.close());
    this.peers = {}; this.remoteStreams = {}; this._iceCandidateQueues = {};
    if (this.localStream)    this.localStream.getTracks().forEach(t => t.stop());
    if (this.screenStream)   this.screenStream.getTracks().forEach(t => t.stop());
    if (this.audioProcessor) this.audioProcessor.destroy();
    db.ref(`signals/${this.meetingId}/${this.userId}`).remove();
  }
}
