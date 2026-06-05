// ============================================================
//  WEBRTC.JS — Peer connections via Firebase RTDB signaling
// ============================================================

class WebRTCManager {
  constructor(meetingId, userId, onRemoteStream, onPeerLeft) {
    this.meetingId      = meetingId;
    this.userId         = userId;
    this.onRemoteStream = onRemoteStream;
    this.onPeerLeft     = onPeerLeft;
    this.peers          = {};           // peerId → RTCPeerConnection
    this.remoteStreams   = {};          // peerId → MediaStream
    this._iceCandidateQueues = {};      // peerId → [candidate] (queued before remote desc)
    this.localStream    = null;
    this.screenStream   = null;
    this.roomRef        = db.ref(`rooms/${meetingId}`);
    this.signalRef      = db.ref(`signals/${meetingId}`);
    this.presenceRef    = db.ref(`presence/${meetingId}/${userId}`);
    this._listeners     = [];
  }

  // ── Get local media ──────────────────────────────────────
  async getLocalStream(videoEnabled = true, audioEnabled = true) {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: videoEnabled ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false,
        audio: audioEnabled ? {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 48000
        } : false
      });
      return this.localStream;
    } catch (err) {
      console.error("getUserMedia error:", err);
      throw err;
    }
  }

  // ── Join room & start signaling ───────────────────────────
  async joinRoom() {
    // Set presence
    this.presenceRef.set({
      userId:      this.userId,
      displayName: getCurrentUser().displayName || "Anonymous",
      photoURL:    getCurrentUser().photoURL || "",
      joinedAt:    firebase.database.ServerValue.TIMESTAMP,
      audio:       true,
      video:       true
    });
    this.presenceRef.onDisconnect().remove();

    // Watch for other participants already in the room or joining
    const presRef = db.ref(`presence/${this.meetingId}`);
    const onChild = presRef.on("child_added", snap => {
      const peerId = snap.key;
      if (peerId === this.userId) return;
      // Deterministic caller rule: larger userId initiates.
      // This prevents "glare" where both sides try to be caller simultaneously.
      const isCaller = this.userId > peerId;
      this._createPeerConnection(peerId, isCaller);
    });
    this._listeners.push({ ref: presRef, event: "child_added", fn: onChild });

    const onChildRemoved = presRef.on("child_removed", snap => {
      const peerId = snap.key;
      this._handlePeerLeft(peerId);
    });
    this._listeners.push({ ref: presRef, event: "child_removed", fn: onChildRemoved });

    // Listen for incoming signals
    const sigRef = db.ref(`signals/${this.meetingId}/${this.userId}`);
    const onSignal = sigRef.on("child_added", async snap => {
      const data = snap.val();
      const { from, type, payload } = data;
      await this._handleSignal(from, type, payload);
      snap.ref.remove();
    });
    this._listeners.push({ ref: sigRef, event: "child_added", fn: onSignal });
  }

  // ── Create peer connection ────────────────────────────────
  async _createPeerConnection(peerId, isCaller) {
    if (this.peers[peerId]) return this.peers[peerId];

    const pc = new RTCPeerConnection(ICE_SERVERS);
    this.peers[peerId] = pc;
    this._iceCandidateQueues[peerId] = [];

    // Add local tracks to the connection
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Build remote stream and notify when tracks arrive
    const remoteStream = new MediaStream();
    this.remoteStreams[peerId] = remoteStream;

    pc.ontrack = evt => {
      const stream = evt.streams && evt.streams[0] ? evt.streams[0] : remoteStream;
      evt.track.onunmute = () => {
        if (!remoteStream.getTracks().find(t => t.id === evt.track.id)) {
          remoteStream.addTrack(evt.track);
        }
        this.onRemoteStream(peerId, remoteStream);
      };
      if (!remoteStream.getTracks().find(t => t.id === evt.track.id)) {
        remoteStream.addTrack(evt.track);
      }
      this.onRemoteStream(peerId, remoteStream);
    };

    // ICE candidates — send to remote peer
    pc.onicecandidate = evt => {
      if (evt.candidate) {
        this._sendSignal(peerId, "ice", evt.candidate.toJSON());
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(pc.iceConnectionState)) {
        this._handlePeerLeft(peerId);
      }
    };

    // Retry on failure
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        console.warn("Connection failed for", peerId, "— restarting ICE");
        try { pc.restartIce(); } catch(_) {}
      }
    };

    if (isCaller) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      this._sendSignal(peerId, "offer", { sdp: offer.sdp, type: offer.type });
    }

    return pc;
  }

  // ── Handle incoming signal ────────────────────────────────
  async _handleSignal(peerId, type, payload) {
    if (type === "offer") {
      let pc = this.peers[peerId];

      if (pc) {
        // Re-offer: update remote description (e.g. after screen share renegotiation)
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(payload));
          await this._drainIceCandidateQueue(peerId);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this._sendSignal(peerId, "answer", { sdp: answer.sdp, type: answer.type });
        } catch(e) {
          console.error("Re-offer handling error:", e);
        }
        return;
      }

      pc = await this._createPeerConnection(peerId, false);
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      await this._drainIceCandidateQueue(peerId);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this._sendSignal(peerId, "answer", { sdp: answer.sdp, type: answer.type });

    } else if (type === "answer") {
      const pc = this.peers[peerId];
      if (pc && pc.signalingState !== "stable") {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(payload));
          await this._drainIceCandidateQueue(peerId);
        } catch(e) {
          console.error("Answer handling error:", e);
        }
      }
    } else if (type === "ice") {
      const pc = this.peers[peerId];
      if (pc && pc.remoteDescription && pc.remoteDescription.type) {
        try { await pc.addIceCandidate(new RTCIceCandidate(payload)); } catch(_) {}
      } else {
        // Queue it until remote description is set
        if (!this._iceCandidateQueues[peerId]) this._iceCandidateQueues[peerId] = [];
        this._iceCandidateQueues[peerId].push(payload);
      }
    }
  }

  // ── Drain queued ICE candidates ───────────────────────────
  async _drainIceCandidateQueue(peerId) {
    const queue = this._iceCandidateQueues[peerId] || [];
    const pc    = this.peers[peerId];
    if (!pc || !queue.length) return;
    for (const candidate of queue) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(_) {}
    }
    this._iceCandidateQueues[peerId] = [];
  }

  // ── Send signal via Firebase ──────────────────────────────
  _sendSignal(targetId, type, payload) {
    db.ref(`signals/${this.meetingId}/${targetId}`).push({ from: this.userId, type, payload });
  }

  // ── Peer left ─────────────────────────────────────────────
  _handlePeerLeft(peerId) {
    if (this.peers[peerId]) {
      this.peers[peerId].close();
      delete this.peers[peerId];
      delete this.remoteStreams[peerId];
      delete this._iceCandidateQueues[peerId];
      this.onPeerLeft(peerId);
    }
  }

  // ── Toggle audio ──────────────────────────────────────────
  setAudioEnabled(enabled) {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach(t => t.enabled = enabled);
    this.presenceRef.update({ audio: enabled });
  }

  // ── Toggle video ──────────────────────────────────────────
  setVideoEnabled(enabled) {
    if (!this.localStream) return;
    this.localStream.getVideoTracks().forEach(t => t.enabled = enabled);
    this.presenceRef.update({ video: enabled });
  }

  // ── Screen share ──────────────────────────────────────────
  async startScreenShare(onEnd) {
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" },
        audio: true
      });
      const screenTrack = this.screenStream.getVideoTracks()[0];

      // Replace video track in all peer connections and renegotiate
      for (const [peerId, pc] of Object.entries(this.peers)) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
        if (sender) {
          await sender.replaceTrack(screenTrack);
          // Trigger renegotiation so remote side gets the new resolution/codec
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this._sendSignal(peerId, "offer", { sdp: offer.sdp, type: offer.type });
          } catch(e) {
            console.error("Screen share renegotiation error:", e);
          }
        }
      }

      screenTrack.onended = () => this.stopScreenShare(onEnd);
      this.presenceRef.update({ screenSharing: true });
      return this.screenStream;
    } catch (err) {
      console.error("Screen share error:", err);
      throw err;
    }
  }

  async stopScreenShare(callback) {
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }
    const camTrack = this.localStream ? this.localStream.getVideoTracks()[0] : null;
    if (camTrack) {
      for (const [peerId, pc] of Object.entries(this.peers)) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
        if (sender) {
          await sender.replaceTrack(camTrack);
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this._sendSignal(peerId, "offer", { sdp: offer.sdp, type: offer.type });
          } catch(e) {
            console.error("Stop screen share renegotiation error:", e);
          }
        }
      }
    }
    this.presenceRef.update({ screenSharing: false });
    if (callback) callback();
  }

  // ── Replace track when device changes ─────────────────────
  async switchCamera(deviceId) {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } },
      audio: false
    });
    const newTrack = newStream.getVideoTracks()[0];
    for (const pc of Object.values(this.peers)) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
      if (sender) sender.replaceTrack(newTrack);
    }
    if (this.localStream) {
      const old = this.localStream.getVideoTracks()[0];
      if (old) old.stop();
      this.localStream.removeTrack(old);
      this.localStream.addTrack(newTrack);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────
  async leave() {
    this.presenceRef.remove();
    Object.values(this.peers).forEach(pc => pc.close());
    this.peers = {};
    this.remoteStreams = {};
    this._iceCandidateQueues = {};
    if (this.localStream)  { this.localStream.getTracks().forEach(t => t.stop()); }
    if (this.screenStream) { this.screenStream.getTracks().forEach(t => t.stop()); }
    // Remove lingering signals
    db.ref(`signals/${this.meetingId}/${this.userId}`).remove();
  }
}
