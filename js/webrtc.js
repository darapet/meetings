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
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 48000
        }
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

    // Watch for other participants
    const presRef = db.ref(`presence/${this.meetingId}`);
    const onChild = presRef.on("child_added", snap => {
      const peerId = snap.key;
      if (peerId !== this.userId) {
        this._createPeerConnection(peerId, true); // we are the caller
      }
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
    if (this.peers[peerId]) return;

    const pc = new RTCPeerConnection(ICE_SERVERS);
    this.peers[peerId] = pc;

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Remote stream
    const remoteStream = new MediaStream();
    pc.ontrack = evt => {
      evt.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
      this.onRemoteStream(peerId, remoteStream);
    };

    // ICE candidates
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

    if (isCaller) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      this._sendSignal(peerId, "offer", { sdp: offer.sdp, type: offer.type });
    }
  }

  // ── Handle incoming signal ────────────────────────────────
  async _handleSignal(peerId, type, payload) {
    if (type === "offer") {
      await this._createPeerConnection(peerId, false);
      const pc = this.peers[peerId];
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this._sendSignal(peerId, "answer", { sdp: answer.sdp, type: answer.type });
    } else if (type === "answer") {
      const pc = this.peers[peerId];
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(payload));
    } else if (type === "ice") {
      const pc = this.peers[peerId];
      if (pc) await pc.addIceCandidate(new RTCIceCandidate(payload));
    }
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
      // Replace video track in all peer connections
      Object.values(this.peers).forEach(pc => {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
        if (sender) sender.replaceTrack(screenTrack);
      });
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
      Object.values(this.peers).forEach(pc => {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
        if (sender) sender.replaceTrack(camTrack);
      });
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
    Object.values(this.peers).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
      if (sender) sender.replaceTrack(newTrack);
    });
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
    if (this.localStream) { this.localStream.getTracks().forEach(t => t.stop()); }
    if (this.screenStream) { this.screenStream.getTracks().forEach(t => t.stop()); }
    // Remove lingering signals
    db.ref(`signals/${this.meetingId}/${this.userId}`).remove();
  }
}
