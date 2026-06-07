// ============================================================
//  MEETING.JS — Core meeting orchestration (Realtime Database)
// ============================================================

let webrtc         = null;
let livekitRoom    = null;   // LiveKit Room instance
let _presRef       = null;   // Firebase presence ref
let transcription  = null;
let aiManager      = null;
let meetingId      = null;
let currentUser    = null;
let isHost         = false;
let audioEnabled   = true;
let videoEnabled   = true;
let screenSharing  = false;
let aiToolsVisible = true;
let meetingData    = {};
let participants   = {};
let aiLastResponse = "";
let recorder       = null;
let remoteStreams   = new Map();
let _meetingRef    = null;

// ============================================================
//  MEETING RECORDER — audio-only, auto-download on end
// ============================================================
class MeetingRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.chunks        = [];
    this.isRecording   = false;
    this.isPaused      = false;
    this.audioCtx      = null;
    this.dest          = null;
    this.audioSources  = new Map();
    this._startTime    = null;
  }

  get durationMs() { return this._startTime ? Date.now() - this._startTime : 0; }

  start(localStream, remoteStreamMap) {
    this.audioCtx  = new AudioContext();
    this.dest      = this.audioCtx.createMediaStreamDestination();
    if (localStream) this._addAudio(localStream, "local");
    remoteStreamMap.forEach((stream, uid) => this._addAudio(stream, uid));

    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"]
      .find(t => MediaRecorder.isTypeSupported(t)) || "audio/webm";

    this.chunks        = [];
    this._startTime    = Date.now();
    this.mediaRecorder = new MediaRecorder(this.dest.stream, { mimeType });
    this.mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) this.chunks.push(e.data); };
    this.mediaRecorder.start(1000);
    this.isRecording = true;
    this.isPaused    = false;
    return true;
  }

  // Pause — chunks collected so far are kept; clock shows paused
  pause() {
    if (!this.mediaRecorder || this.mediaRecorder.state !== "recording") return false;
    this.mediaRecorder.pause();
    this.isPaused = true;
    return true;
  }

  // Resume — recording picks up exactly where it left off
  resume() {
    if (!this.mediaRecorder || this.mediaRecorder.state !== "paused") return false;
    this.mediaRecorder.resume();
    this.isPaused = false;
    return true;
  }

  _addAudio(stream, id) {
    if (!this.audioCtx || !stream) return;
    const tracks = stream.getAudioTracks();
    if (!tracks.length) return;
    try {
      const src = this.audioCtx.createMediaStreamSource(new MediaStream(tracks));
      src.connect(this.dest);
      this.audioSources.set(id, src);
    } catch (_) {}
  }

  addRemoteStream(uid, stream) { if (this.isRecording) this._addAudio(stream, uid); }

  stop() {
    return new Promise(resolve => {
      if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") { resolve(null); return; }
      this.mediaRecorder.onstop = () => {
        if (this.audioCtx) this.audioCtx.close().catch(() => {});
        this.isRecording = false;
        this.isPaused    = false;
        const mimeType = this.mediaRecorder.mimeType || "audio/webm";
        resolve(new Blob(this.chunks, { type: mimeType }));
      };
      if (this.mediaRecorder.state === "paused") this.mediaRecorder.resume();
      this.mediaRecorder.stop();
    });
  }
}

// ── Bootstrap ──────────────────────────────────────────────
async function initMeeting() {
  const params = new URLSearchParams(window.location.search);
  meetingId = params.get("id");
  if (!meetingId) { window.location.href = "dashboard.html"; return; }

  onAuthReady(async user => {
    if (!user) {
      window.location.href = "index.html?next=" + encodeURIComponent(location.href);
      return;
    }
    currentUser = user;
    hideAuthSpinner();

    await setupLocalMedia();
    await loadMeetingData();

    try { setupWebRTC();              } catch (e) { console.error("WebRTC:", e); }
    try { setupTranscription();       } catch (e) { console.error("Transcription:", e); }
    try { setupAI();                  } catch (e) { console.error("AI:", e); }
    try { setupChat();                } catch (e) { console.error("Chat:", e); }
    try { setupPresenceDisplay();     } catch (e) { console.error("Presence:", e); }
    try { setupAIBroadcastListener();    } catch (e) { console.error("AI Broadcast:", e); }
    try { setupHostCommandListener();    } catch (e) { console.error("HostCmd:", e); }
    try { setupPetAIBroadcast();         } catch (e) { console.error("PetAI Broadcast:", e); }
    updateHostControls();
    startMeetingTimer();
    if (isHost) try { listenForJoinRequests(); } catch (e) { console.error("WaitingRoom:", e); }
    try { initPetAI(); } catch (e) { console.error("PetAI:", e); }
    // Auto-start audio recording for the host
    if (isHost && webrtc?.localStream) {
      try { startRecording(); } catch (e) { console.error("AutoRecord:", e); }
    }
  });
}

// ── Load meeting data ─────────────────────────────────────
async function loadMeetingData() {
  try {
    _meetingRef = db.ref("meetings/" + meetingId);
    const snap  = await _meetingRef.once("value");
    if (!snap.exists()) { document.getElementById("meetingTitle").textContent = "Meeting"; return; }
    meetingData = snap.val();
    isHost      = meetingData.hostId === currentUser.uid;
    document.title = (meetingData.name || "Meeting") + " — MeetAI";
    document.getElementById("meetingTitle").textContent = meetingData.name || "Meeting";
    _meetingRef.child("participants/" + currentUser.uid).set(true).catch(() => {});
    if (isHost) _meetingRef.update({ status: "active", lastActivity: firebase.database.ServerValue.TIMESTAMP }).catch(() => {});
    _meetingRef.on("value", snap => {
      if (!snap.exists()) return;
      const d = snap.val();
      if (d.status === "ended" && !isHost) {
        showMeetingError("The host has ended this meeting.");
        setTimeout(() => { window.location.href = "dashboard.html"; }, 3000);
      }
    });
    if (isHost) { try { listenForJoinRequests(); } catch (e) { console.error("JoinReq:", e); } }
  } catch (err) {
    document.getElementById("meetingTitle").textContent = "Meeting";
  }
}

// ── Local media ───────────────────────────────────────────
// LiveKit handles camera/mic internally; we keep a minimal shim for the recorder
async function setupLocalMedia() {
  webrtc = { localStream: null };  // filled after LiveKit connects
}
// ── Remote streams ────────────────────────────────────────
function onRemoteStream(peerId, stream) {
  remoteStreams.set(peerId, stream);
  if (recorder && recorder.isRecording) recorder.addRemoteStream(peerId, stream);

  // If this participant's tile already exists, update the video immediately
  // without a Firebase round-trip — critical for screen share track swaps
  if (participants[peerId]) {
    const data = participants[peerId];
    addParticipantTile(peerId, data.displayName || "Participant", data.photoURL || "", false, stream);
    // Force video element to restart playback so the new track renders right away
    const vidEl = document.getElementById("vid-" + peerId);
    if (vidEl) { vidEl.srcObject = stream; vidEl.play().catch(() => {}); }
    return;
  }

  // New participant — must fetch presence data first
  db.ref("presence/" + meetingId + "/" + peerId).once("value", snap => {
    const data = snap.val() || {};
    participants[peerId] = data;
    addParticipantTile(peerId, data.displayName || "Participant", data.photoURL || "", false, stream);
    if (data.displayName) showToast("✦ " + data.displayName + " joined");
    updateParticipantSidebar();
  });
}

function onPeerLeft(peerId) {
  const name = participants[peerId]?.displayName;
  if (name) showToast("← " + name + " left the meeting");
  remoteStreams.delete(peerId);
  removeParticipantTile(peerId);
  delete participants[peerId];
  updateParticipantCount();
  updateParticipantSidebar();
}

// ── Network quality callback ──────────────────────────────
// Called by WebRTCManager when any peer's quality changes
// Also called for own uid when measuring upload quality
function onNetworkQuality(uid, quality, stats) {
  _setTileNetworkQuality(uid, quality, stats);
  // Own network — also show in header bar
  if (uid === currentUser?.uid) {
    const headerInd = document.getElementById("ownNetworkIndicator");
    if (headerInd) {
      headerInd.className = "own-net-indicator net-" + quality;
      headerInd.title = quality === "reconnecting"
        ? "Your network: reconnecting…"
        : `Your network: ${quality}` + (stats?.rtt ? ` (${stats.rtt}ms)` : "");
      headerInd.innerHTML = _signalBarsHtml(quality);
    }
    if (quality === "poor") {
      showToast("⚠ Your network is weak — others may hear you poorly");
    }
  }
}

// ── Network indicator on participant tiles ────────────────
function _setTileNetworkQuality(uid, quality, stats) {
  const tile = document.getElementById("tile-" + uid);
  if (!tile) return;

  let indicator = tile.querySelector(".net-ind");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.className = "net-ind";
    tile.appendChild(indicator);
  }
  indicator.className   = "net-ind net-" + quality;
  indicator.title       = quality === "reconnecting"
    ? "Reconnecting…"
    : `Network: ${quality}` + (stats?.rtt ? ` (${stats.rtt}ms RTT)` : "");
  indicator.innerHTML   = _signalBarsHtml(quality);

  // Reconnecting overlay
  let overlay = tile.querySelector(".reconnect-overlay");
  if (quality === "reconnecting") {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "reconnect-overlay";
      overlay.innerHTML = `<div class="reconnect-spinner"></div><span>Reconnecting…</span>`;
      tile.appendChild(overlay);
    }
  } else {
    overlay?.remove();
  }
}

function _signalBarsHtml(quality) {
  const bars = quality === "reconnecting"
    ? `<svg class="net-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
       </svg>`
    : `<svg width="13" height="10" viewBox="0 0 13 10" fill="currentColor">
        <rect x="0"  y="6" width="3" height="4" opacity="${quality === 'poor' || quality === 'fair' || quality === 'good' ? '1' : '0.25'}"/>
        <rect x="5"  y="3" width="3" height="7" opacity="${quality === 'fair' || quality === 'good' ? '1' : '0.25'}"/>
        <rect x="10" y="0" width="3" height="10" opacity="${quality === 'good' ? '1' : '0.25'}"/>
       </svg>`;
  return bars;
}

// ── Participant grid ──────────────────────────────────────
function addParticipantTile(uid, name, photo, isLocal, stream) {
  const grid = document.getElementById("participantGrid");
  if (!grid) return;
  let tile = document.getElementById("tile-" + uid);
  if (!tile) {
    tile = document.createElement("div");
    tile.id        = "tile-" + uid;
    tile.className = "participant-tile";
    const hostBadge = (uid === meetingData.hostId) ? `<span class="tile-host-badge">Host</span>` : "";
    tile.innerHTML = `
      <video autoplay playsinline ${isLocal ? "muted" : ""} id="vid-${uid}"></video>
      <div class="tile-avatar" id="avatar-${uid}">
        ${photo ? `<img src="${photo}" alt="">` : `<span>${escapeHtml(getInitials(name))}</span>`}
      </div>
      <div class="tile-name">${escapeHtml(name || "?")}${isLocal ? " (You)" : ""} ${hostBadge}</div>
      <div class="tile-status">
        <span class="status-icon" id="mic-${uid}" title="Mic">
          <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        </span>
        <span class="status-icon" id="cam-${uid}" title="Camera">
          <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>
          </svg>
        </span>
      </div>`;
    grid.appendChild(tile);
  }
  const vidEl = document.getElementById("vid-" + uid);
  if (stream && vidEl) {
    vidEl.srcObject = stream;
    if (!isLocal) _tryPlayVideo(uid, vidEl);
  }
  _setTileVideoVisible(uid, isLocal ? videoEnabled : true);
  updateParticipantCount();
}

// ── Global audio unlock (replaces per-tile tap-to-hear overlays) ──────────
let _audioUnlocked = false;
const _pendingVideoPlays = new Map();

function _tryPlayVideo(uid, vid) {
  if (!vid) return;
  vid.play().then(() => {
    _pendingVideoPlays.delete(uid);
  }).catch(err => {
    if (err.name === "NotAllowedError" || err.name === "NotSupportedError") {
      _pendingVideoPlays.set(uid, vid);
      _showAudioUnlockBar();
    }
  });
}

function _showAudioUnlockBar() {
  if (document.getElementById("audioUnlockBar")) return;
  const bar = document.createElement("div");
  bar.id = "audioUnlockBar";
  bar.className = "audio-unlock-bar";
  bar.innerHTML = `<button class="audio-unlock-btn" onclick="_doUnlockAudio()">🔊 Tap here to enable audio from all participants</button>`;
  document.body.appendChild(bar);
}

function _doUnlockAudio() {
  _audioUnlocked = true;
  document.getElementById("audioUnlockBar")?.remove();
  _pendingVideoPlays.forEach((vid) => vid.play().catch(() => {}));
  _pendingVideoPlays.clear();
}

// Auto-unlock on any user gesture
["click","touchstart","keydown"].forEach(evt =>
  document.addEventListener(evt, () => {
    if (!_audioUnlocked && _pendingVideoPlays.size > 0) _doUnlockAudio();
  }, { passive: true })
);

function removeParticipantTile(uid)  { document.getElementById("tile-" + uid)?.remove(); updateParticipantCount(); }

function _setTileVideoVisible(uid, visible) {
  const vid    = document.getElementById("vid-" + uid);
  const avatar = document.getElementById("avatar-" + uid);
  if (!vid || !avatar) return;
  vid.style.display    = visible ? "block" : "none";
  avatar.style.display = visible ? "none"  : "flex";
}

function updateParticipantCount() {
  const el = document.getElementById("participantCount");
  if (el) el.textContent = document.querySelectorAll(".participant-tile").length;
}

// ── Presence live-sync ────────────────────────────────────
function setupPresenceDisplay() {
  const presRef = db.ref("presence/" + meetingId);

  presRef.on("child_added", snap => {
    const uid = snap.key, data = snap.val() || {};
    if (uid !== currentUser.uid) {
      const isNew = !participants[uid];
      participants[uid] = data;
      if (isNew && data.displayName) showToast("✦ " + data.displayName + " joined");
      // Apply saved network quality if present
      if (data.networkQuality) _setTileNetworkQuality(uid, data.networkQuality, null);
      updateParticipantSidebar();
    }
  });

  presRef.on("child_changed", snap => {
    const uid = snap.key, data = snap.val() || {};
    participants[uid] = data;
    const micIcon = document.getElementById("mic-" + uid);
    const camIcon = document.getElementById("cam-" + uid);
    if (micIcon) micIcon.style.opacity = data.audio === false ? "0.3" : "1";
    if (camIcon) camIcon.style.opacity = data.video === false ? "0.3" : "1";
    _setTileVideoVisible(uid, data.video !== false || !!data.screenSharing);
    if (data.networkQuality) _setTileNetworkQuality(uid, data.networkQuality, null);
    const tile = document.getElementById("tile-" + uid);
    if (tile) {
      const existing = tile.querySelector(".hand-badge");
      if (data.handRaised && !existing) {
        const b = document.createElement("div");
        b.className = "hand-badge";
        b.style.cssText = "position:absolute;top:8px;left:8px;font-size:1rem;background:rgba(0,0,0,.55);border-radius:6px;padding:2px 6px;z-index:2;";
        b.textContent = "✋"; tile.appendChild(b);
        showToast("✋ " + (data.displayName || "Someone") + " raised their hand");
      } else if (!data.handRaised && existing) { existing.remove(); }
      // Screen share badge — update in real-time without requiring a refresh
      const existingScreenBadge = tile.querySelector(".screen-share-badge");
      if (data.screenSharing && !existingScreenBadge) {
        const sb = document.createElement("div");
        sb.className = "screen-share-badge";
        sb.textContent = "🖥 Sharing";
        tile.appendChild(sb);
      } else if (!data.screenSharing && existingScreenBadge) {
        existingScreenBadge.remove();
      }
    }
    updateParticipantSidebar();
  });

  presRef.on("child_removed", snap => {
    const uid = snap.key;
    if (uid !== currentUser.uid) {
      const name = participants[uid]?.displayName;
      if (name) showToast("← " + name + " left");
      delete participants[uid]; updateParticipantSidebar();
    }
  });
}

// ── Sidebar people list ───────────────────────────────────
function updateParticipantSidebar() {
  const list = document.getElementById("participantsList");
  if (!list) return;
  list.innerHTML = "";
  _appendParticipantItem(list, currentUser.uid, currentUser.displayName, currentUser.photoURL, true);
  Object.entries(participants).forEach(([uid, data]) => {
    if (uid !== currentUser.uid) _appendParticipantItem(list, uid, data.displayName, data.photoURL, false, data);
  });
}

function _appendParticipantItem(list, uid, name, photo, isLocal, data = {}) {
  const item = document.createElement("div");
  item.id        = "pitem-" + uid;
  item.className = "participant-item";
  const initials = escapeHtml(getInitials(name || "?"));
  const avatar   = photo
    ? `<img src="${escapeHtml(photo)}" class="p-avatar-img" alt="">`
    : `<div class="p-avatar-initials">${initials}</div>`;
  const netQ     = data.networkQuality || "good";
  const netBadge = netQ !== "good"
    ? `<span class="p-net-badge net-${netQ}" title="Network: ${netQ}">${_signalBarsHtml(netQ)}</span>`
    : "";
  const isMuted  = data.audio === false;
  const isHostUser = uid === meetingData?.hostId;
  const hostBadge = isHostUser
    ? `<span style="font-size:.6rem;background:var(--accent);color:#fff;padding:1px 5px;border-radius:4px;font-weight:700;vertical-align:middle;">Host</span> `
    : "";
  const micStatus = isMuted
    ? `<span style="color:#ef4444;font-size:.7rem;">🔇 Muted</span>`
    : `<span style="color:#22c55e;font-size:.7rem;">🎤 Live</span>`;

  let hostButtons = "";
  if (isHost && !isLocal) {
    if (isMuted) {
      hostButtons = `<button class="p-unmute-btn" onclick="hostMuteParticipant('${uid}')" title="Request unmute">
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        </svg>
      </button>`;
    } else {
      hostButtons = `<button class="p-mute-btn" onclick="hostMuteParticipant('${uid}')" title="Mute">
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
          <line x1="1" y1="1" x2="23" y2="23"/>
          <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
          <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
        </svg>
      </button>`;
    }
  }
  item.innerHTML = `
    <div class="p-avatar">${avatar}</div>
    <div class="p-info">
      <div class="p-name">${hostBadge}${escapeHtml(name || "Participant")}${isLocal ? " <span class='p-you'>(You)</span>" : ""}</div>
      <div class="p-sub">${micStatus}</div>
    </div>
    ${netBadge}
    ${hostButtons}`;
  list.appendChild(item);
}

// ── LiveKit setup ────────────────────────────────────────

async function generateLiveKitToken(roomName, identity, displayName) {
  const apiKey = LIVEKIT_API_KEY, apiSecret = LIVEKIT_API_SECRET;
  const now = Math.floor(Date.now() / 1000), exp = now + 4 * 3600;
  const b64url = obj => btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header  = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ video: { roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true }, sub: identity, name: displayName, iss: apiKey, nbf: now, exp });
  const sigInput = header + '.' + payload;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sigInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return sigInput + '.' + sigB64;
}

function setupWebRTC() { setupLiveKit(); }

async function setupLiveKit() {
  const { Room, RoomEvent, Track } = LivekitClient;
  const roomName = 'meetai-' + meetingId;
  const identity = currentUser.uid;
  const displayName = currentUser.displayName || 'Guest';

  _presRef = db.ref('presence/' + meetingId + '/' + identity);
  _presRef.set({ userId: identity, displayName, photoURL: currentUser.photoURL || '', joinedAt: firebase.database.ServerValue.TIMESTAMP, audio: true, video: true, networkQuality: 'good' });
  _presRef.onDisconnect().remove();

  webrtc = webrtc || {};
  webrtc.presenceRef     = _presRef;
  webrtc.setAudioEnabled = (on) => livekitRoom?.localParticipant?.setMicrophoneEnabled(on).catch(() => {});
  webrtc.setVideoEnabled = (on) => livekitRoom?.localParticipant?.setCameraEnabled(on).catch(() => {});
  webrtc.leave           = () => livekitRoom?.disconnect();

  const token = await generateLiveKitToken(roomName, identity, displayName);
  livekitRoom = new Room({ adaptiveStream: true, dynacast: true });

  livekitRoom
    .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      _lkAttach(track, participant.identity, participant.name || participant.identity);
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => { track.detach(); })
    .on(RoomEvent.ParticipantConnected, (p) => {
      _lkTile(p.identity, p.name || p.identity, false);
      onRemoteStream(p.identity, new MediaStream());
    })
    .on(RoomEvent.ParticipantDisconnected, (p) => {
      document.getElementById('tile-' + p.identity)?.remove();
      onPeerLeft(p.identity);
    });

  livekitRoom.localParticipant.on('trackMuted', pub => {
    if (pub.kind === Track.Kind.Audio) { audioEnabled = false; _presRef?.update({ audio: false }); if (typeof _syncMicIcon === 'function') _syncMicIcon(false); }
    if (pub.kind === Track.Kind.Video) { videoEnabled = false; _presRef?.update({ video: false }); if (typeof _syncCamIcon === 'function') _syncCamIcon(false); }
  });
  livekitRoom.localParticipant.on('trackUnmuted', pub => {
    if (pub.kind === Track.Kind.Audio) { audioEnabled = true; _presRef?.update({ audio: true }); if (typeof _syncMicIcon === 'function') _syncMicIcon(true); }
    if (pub.kind === Track.Kind.Video) { videoEnabled = true; _presRef?.update({ video: true }); if (typeof _syncCamIcon === 'function') _syncCamIcon(true); }
  });

  try {
    await livekitRoom.connect(LIVEKIT_URL, token);
    await livekitRoom.localParticipant.enableCameraAndMicrophone();
    const camPub = [...livekitRoom.localParticipant.videoTrackPublications.values()][0];
    if (camPub?.videoTrack) {
      const el = camPub.videoTrack.attach();
      el.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:8px;background:#000;';
      const tile = _lkTile(identity, displayName + ' (You)', true);
      tile.querySelector('.lk-video').appendChild(el);
    }
    const micPub = [...livekitRoom.localParticipant.audioTrackPublications.values()][0];
    if (micPub?.track?.mediaStreamTrack) webrtc.localStream = new MediaStream([micPub.track.mediaStreamTrack]);
    showToast('✦ Connected to LiveKit room');
  } catch (err) {
    console.error('LiveKit connect error:', err);
    showToast('Video connection failed: ' + err.message);
  }
}

function _lkTile(identity, name, isLocal) {
  let tile = document.getElementById('tile-' + identity);
  if (!tile) {
    const grid = document.getElementById('livekitGrid');
    tile = document.createElement('div');
    tile.id = 'tile-' + identity;
    tile.style.cssText = 'position:relative;background:#1a1e2a;border-radius:10px;overflow:hidden;aspect-ratio:16/9;min-height:160px;display:flex;align-items:center;justify-content:center;';
    tile.innerHTML = '<div class="lk-video" style="width:100%;height:100%;"></div><div style="position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,0.65);color:#fff;padding:3px 8px;border-radius:6px;font-size:0.78rem;font-weight:600;">' + escapeHtml(name) + (isLocal ? '' : '') + '</div>';
    if (grid) grid.appendChild(tile);
  }
  return tile;
}

function _lkAttach(track, identity, name) {
  const el = track.attach();
  if (track.kind === 'audio') { el.style.display = 'none'; document.body.appendChild(el); return; }
  el.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:8px;background:#000;';
  const tile = _lkTile(identity, name, false);
  tile.querySelector('.lk-video').innerHTML = '';
  tile.querySelector('.lk-video').appendChild(el);
}

async function toggleScreenShare() {
  if (!livekitRoom) { showToast('Video not ready yet.'); return; }
  try {
    screenSharing = !screenSharing;
    await livekitRoom.localParticipant.setScreenShareEnabled(screenSharing);
    _presRef?.update({ screenSharing });
    if (typeof _updateScreenBtn === 'function') _updateScreenBtn(screenSharing);
  } catch (err) { screenSharing = !screenSharing; showToast('Screen share: ' + err.message); }
}

function setupTranscription() {
  if (typeof LiveTranscription === "undefined") return;
  transcription = new LiveTranscription(
    chunk  => _onTranscriptChunk(chunk),
    err    => {
      console.warn("Transcription:", err);
      showToast("🎙 Transcription: " + err);
      _onTranscriptStatus("error");
    },
    status => _onTranscriptStatus(status)
  );
  if (transcription.isSupported()) {
    transcription.start();
  } else {
    _onTranscriptStatus("unsupported");
    const liveEl = document.getElementById("transcriptContent");
    if (liveEl) liveEl.innerHTML = '<p style="color:var(--warning);font-size:.82rem;">⚠️ Live transcription requires Chrome or Edge. Switch browsers to enable it.</p>';
  }
}

let _interimEl = null;
function _onTranscriptChunk({ type, text, fullText }) {
  const liveEl = document.getElementById("transcriptContent");
  if (!liveEl) return;
  if (type === "final") {
    _interimEl?.remove(); _interimEl = null;
    const p = document.createElement("p");
    const ts = document.createElement("span");
    ts.className = "ts"; ts.textContent = _getTimestamp();
    p.appendChild(ts); p.append(" " + text);
    liveEl.appendChild(p);
    liveEl.scrollTop = liveEl.scrollHeight;
  } else if (type === "interim") {
    if (!_interimEl) {
      _interimEl = document.createElement("p");
      _interimEl.className = "interim"; liveEl.appendChild(_interimEl);
    }
    _interimEl.textContent = text;
    liveEl.scrollTop = liveEl.scrollHeight;
  }
}

function _onTranscriptStatus(status) {
  const el = document.getElementById("transcriptStatus");
  if (el) {
    el.textContent = status === "listening" ? "● Live" : status === "silence" ? "◌ Listening…" : status;
    el.className   = "transcript-status ts-" + status;
  }
}

// ── AI ────────────────────────────────────────────────────
function setupAI() {
  if (typeof AIManager === "undefined") return;
  aiManager = new AIManager(meetingId, currentUser.uid, isHost, resp => {
    aiLastResponse = resp;
    const el = document.getElementById("aiResponse");
    if (el) el.innerHTML = _markdownToHtml(escapeHtml(resp));
  });
  // Wire up Book Mode toggle
  const bookToggle = document.getElementById("bookModeToggle");
  if (bookToggle) {
    bookToggle.addEventListener("change", () => { if (aiManager) aiManager.bookMode = bookToggle.checked; });
  }
}

// ── Chat ──────────────────────────────────────────────────
function setupChat() {
  const chatRef  = db.ref("chat/" + meetingId);
  const chatList = document.getElementById("chatLog");
  if (!chatList) return;
  chatRef.limitToLast(50).on("child_added", snap => {
    const msg = snap.val();
    if (!msg) return;
    const isMe = msg.uid === currentUser.uid;
    const div  = document.createElement("div");
    div.className = "chat-msg" + (isMe ? " chat-me" : "");
    div.innerHTML = `
      <div class="chat-sender">${escapeHtml(isMe ? "You" : (msg.displayName || "Participant"))}</div>
      <div class="chat-bubble">${escapeHtml(msg.text)}</div>
      <div class="chat-time">${_getTimestamp()}</div>`;
    chatList.appendChild(div);
    chatList.scrollTop = chatList.scrollHeight;
  });
}

function sendChatMessage() {
  const input = document.getElementById("chatInput");
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  db.ref("chat/" + meetingId).push({
    uid: currentUser.uid, displayName: currentUser.displayName || "You",
    text, ts: firebase.database.ServerValue.TIMESTAMP
  });
  input.value = "";
}

// ── AI broadcast ──────────────────────────────────────────
function setupAIBroadcastListener() {
  let _prevMicStateForAI = null;

  // Show banner to ALL when AI is active (thinking/generating)
  db.ref("aiActivity/" + meetingId).on("value", snap => {
    const data   = snap.val();
    const banner = document.getElementById("aiBroadcastBanner");
    const textEl = document.getElementById("aiBroadcastText");
    if (!data || !data.active || !data.uid) {
      // Only hide if not currently in speaking phase
      db.ref("aiSpeaking/" + meetingId).once("value", ss => {
        if (!ss.val()?.speaking) {
          if (banner) banner.style.display = "none";
          document.querySelectorAll("#participantGrid .participant-tile").forEach(t => t.classList.remove("ai-speaking"));
        }
      });
      return;
    }
    // Show to ALL participants
    db.ref("presence/" + meetingId + "/" + data.uid).once("value", pSnap => {
      const name = pSnap.val()?.displayName || "Someone";
      if (textEl) textEl.textContent = (data.uid === currentUser.uid ? "MeetAI" : name + "'s MeetAI") + " is thinking…";
      if (banner) banner.style.display = "flex";
    });
    document.querySelectorAll("#participantGrid .participant-tile").forEach(t => t.classList.add("ai-speaking"));
  });

  // Mute/unmute mics based on AI speaking state — affects ALL participants
  db.ref("aiSpeaking/" + meetingId).on("value", snap => {
    const data   = snap.val();
    const banner = document.getElementById("aiBroadcastBanner");
    const textEl = document.getElementById("aiBroadcastText");

    if (!data || !data.speaking) {
      // AI stopped speaking — restore mics for non-summoners
      if (_prevMicStateForAI !== null) {
        audioEnabled = _prevMicStateForAI;
        webrtc?.setAudioEnabled(audioEnabled);
        if (typeof _syncMicIcon === "function") _syncMicIcon(audioEnabled);
        _prevMicStateForAI = null;
      }
      // Hide banner only if AI activity also ended
      db.ref("aiActivity/" + meetingId).once("value", as => {
        if (!as.val()?.active) {
          if (banner) banner.style.display = "none";
          document.querySelectorAll("#participantGrid .participant-tile").forEach(t => t.classList.remove("ai-speaking"));
        }
      });
      return;
    }

    // AI is speaking — show glowing banner to ALL
    if (textEl) textEl.textContent = "✦ MeetAI is speaking — mics paused";
    if (banner) banner.style.display = "flex";
    document.querySelectorAll("#participantGrid .participant-tile").forEach(t => t.classList.add("ai-speaking"));

    // Mute non-summoner mics
    if (data.uid !== currentUser?.uid) {
      if (_prevMicStateForAI === null) _prevMicStateForAI = audioEnabled;
      if (audioEnabled) {
        audioEnabled = false;
        webrtc?.setAudioEnabled(false);
        if (typeof _syncMicIcon === "function") _syncMicIcon(false);
        showToast("✦ MeetAI is speaking — mic paused");
      }
    }
  });
}

function _broadcastAIActivity(active) {
  db.ref("aiActivity/" + meetingId).set(
    active ? { uid: currentUser.uid, active: true, ts: firebase.database.ServerValue.TIMESTAMP } : null
  ).catch(() => {});
}

function _broadcastAISpeaking(speaking) {
  db.ref("aiSpeaking/" + meetingId).set(
    speaking ? { uid: currentUser.uid, speaking: true, ts: firebase.database.ServerValue.TIMESTAMP } : { speaking: false }
  ).catch(() => {});
}

// ── Controls ──────────────────────────────────────────────
// toggleAudio is called by the mic button in meeting.html
function toggleAudio() {
  audioEnabled = !audioEnabled;
  livekitRoom?.localParticipant?.setMicrophoneEnabled(audioEnabled).catch(() => {});
  if (typeof _syncMicIcon === "function") _syncMicIcon(audioEnabled);
}
function toggleMic() { toggleAudio(); }

function toggleVideo() {
  videoEnabled = !videoEnabled;
  livekitRoom?.localParticipant?.setCameraEnabled(videoEnabled).catch(() => {});
  if (typeof _syncCamIcon === "function") _syncCamIcon(videoEnabled);
}
// ── Host controls ─────────────────────────────────────────
function updateHostControls() {
  const panel   = document.getElementById("hostControls");
  const recWrap = document.getElementById("recordWrap");
  const recPause = document.getElementById("pauseRecordWrap");
  if (panel)    panel.style.display    = isHost ? "flex" : "none";
  if (recWrap)  recWrap.style.display  = isHost ? "flex" : "none";
  if (recPause) recPause.style.display = "none"; // only show when recording
}

function toggleAIToolsVisibility() {
  aiToolsVisible = !aiToolsVisible;
  document.querySelectorAll(".ai-tools-panel").forEach(p => {
    p.style.visibility    = aiToolsVisible ? "visible" : "hidden";
    p.style.pointerEvents = aiToolsVisible ? "auto"    : "none";
  });
  const btn = document.getElementById("toggleAIVisBtn");
  if (btn) btn.innerHTML = aiToolsVisible
    ? `<svg width="13" height="13" id="aiVisIcon"><use href="#ic-eye-off"/></svg> Hide AI`
    : `<svg width="13" height="13" id="aiVisIcon"><use href="#ic-eye"/></svg> Show AI`;
}

// ── Recording ─────────────────────────────────────────────
function toggleRecording() {
  if (!recorder || !recorder.isRecording) startRecording();
  else stopRecordingAndSave();
}

function startRecording() {
  if (!isHost) { showToast("Only the host can record."); return; }
  if (!webrtc?.localStream) { showToast("Mic not ready — recording unavailable."); return; }
  recorder = new MeetingRecorder();
  recorder.start(webrtc.localStream, remoteStreams);
  if (typeof _syncRecordIcon === "function") _syncRecordIcon(true);
  // Show pause button
  const pw = document.getElementById("pauseRecordWrap");
  if (pw) pw.style.display = "flex";
  showToast("● Recording started");
}

// Stop recording → immediately download the file (no dialog)
async function stopRecordingAndSave() {
  if (!recorder) return null;
  const durationMs = recorder.durationMs;
  const blob = await recorder.stop();
  recorder = null;
  if (typeof _syncRecordIcon === "function") _syncRecordIcon(false);
  _syncPauseIcon(false, false);
  const pw = document.getElementById("pauseRecordWrap");
  if (pw) pw.style.display = "none";
  if (blob && blob.size > 0) {
    _downloadRecording(blob, durationMs);
    showToast("Recording saved & downloading…");
    return blob;
  }
  showToast("Recording stopped");
  return null;
}

// Pause / resume toggle
function togglePauseRecording() {
  if (!recorder || !recorder.isRecording) return;
  if (recorder.isPaused) {
    recorder.resume();
    _syncPauseIcon(true, false);
    showToast("▶ Recording resumed");
  } else {
    recorder.pause();
    _syncPauseIcon(true, true);
    showToast("⏸ Recording paused");
  }
}

function _syncPauseIcon(recording, paused) {
  const btn = document.getElementById("pauseRecordBtn");
  const lbl = document.getElementById("pauseRecordLabel");
  if (!btn) return;
  btn.innerHTML = paused
    ? `<svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
    : `<svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
  btn.title = paused ? "Resume Recording" : "Pause Recording";
  btn.classList.toggle("paused", paused);
  if (lbl) lbl.textContent = paused ? "Resume" : "Pause";
}

function _downloadRecording(blob, durationMs = 0) {
  const name     = (meetingData.name || "meeting").replace(/\s+/g, "-").toLowerCase();
  const ts       = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const ext      = blob.type.includes("ogg") ? ".ogg" : ".webm";
  const filename = name + "_" + ts + ext;
  const url      = URL.createObjectURL(blob);
  const a        = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  // Save metadata to localStorage so the dashboard can show the recording history
  try {
    const recs = JSON.parse(localStorage.getItem("meetai_recordings") || "[]");
    recs.unshift({
      meetingId,
      meetingName: meetingData.name || "Meeting",
      filename,
      date:        new Date().toISOString(),
      sizeMb:      (blob.size / (1024 * 1024)).toFixed(1),
      durationSec: Math.round(durationMs / 1000),
    });
    if (recs.length > 30) recs.length = 30;
    localStorage.setItem("meetai_recordings", JSON.stringify(recs));
  } catch (_) {}
}

// ── Waiting room ──────────────────────────────────────────
function listenForJoinRequests() {
  const reqRef = db.ref("joinRequests/" + meetingId);
  reqRef.orderByChild("status").equalTo("pending").once("value", snap => { snap.forEach(c => showAdmissionRequest(c.key, c.val())); });
  reqRef.on("child_added",   snap => { const d = snap.val(); if (d?.status === "pending") showAdmissionRequest(snap.key, d); });
  reqRef.on("child_changed", snap => { const d = snap.val(); if (d?.status === "pending") showAdmissionRequest(snap.key, d); });
}

function showAdmissionRequest(uid, data) {
  if (document.getElementById("req-" + uid)) return;
  const container = document.getElementById("admissionQueue");
  if (!container) return;
  const card = document.createElement("div");
  card.id = "req-" + uid; card.className = "admission-card";
  const photo = data.photoURL
    ? `<img src="${data.photoURL}" class="adm-photo" alt="">`
    : `<div class="adm-photo adm-initials">${escapeHtml(getInitials(data.displayName || "?"))}</div>`;

  // Build extra info (email + custom fields if present)
  let extraInfo = "";
  if (data.email) extraInfo += `<div class="adm-extra">✉ ${escapeHtml(data.email)}</div>`;
  if (data.customFields && typeof data.customFields === "object") {
    Object.entries(data.customFields).forEach(([label, val]) => {
      if (val) extraInfo += `<div class="adm-extra">${escapeHtml(label)}: ${escapeHtml(String(val))}</div>`;
    });
  }

  card.innerHTML = `${photo}
    <div class="adm-info">
      <div class="adm-name">${escapeHtml(data.displayName || "Guest")}</div>
      <div class="adm-sub">wants to join</div>
      ${extraInfo}
    </div>
    <div class="adm-actions">
      <button class="btn btn-success btn-sm" onclick="admitGuest('${uid}')">Admit</button>
      <button class="btn btn-danger  btn-sm" onclick="declineGuest('${uid}')">Decline</button>
    </div>`;
  container.appendChild(card); container.style.display = "flex";

  // Sound notification
  _playNotificationBeep();

  // Floating popup notification
  _showWaitingRoomPopup(uid, data);
}

function _showWaitingRoomPopup(uid, data) {
  // Remove any existing popup for this user
  document.getElementById("wrpopup-" + uid)?.remove();
  const popup = document.createElement("div");
  popup.id = "wrpopup-" + uid;
  popup.className = "waiting-room-popup";
  popup.innerHTML = `
    <div class="wr-popup-header">🔔 Waiting Room</div>
    <div class="wr-popup-name">${escapeHtml(data.displayName || "Guest")} wants to join</div>
    <div class="wr-popup-btns">
      <button class="btn btn-success btn-sm" onclick="admitGuest('${uid}');document.getElementById('wrpopup-${uid}')?.remove()">Admit</button>
      <button class="btn btn-danger  btn-sm" onclick="declineGuest('${uid}');document.getElementById('wrpopup-${uid}')?.remove()">Decline</button>
      <button class="btn btn-ghost   btn-sm" onclick="document.getElementById('wrpopup-${uid}')?.remove()">✕</button>
    </div>`;
  document.body.appendChild(popup);
  // Auto-dismiss after 30 seconds
  setTimeout(() => popup.remove(), 30000);
}

function admitGuest(uid) {
  db.ref("joinRequests/" + meetingId + "/" + uid).update({ status: "admitted" }).catch(() => {});
  document.getElementById("req-" + uid)?.remove(); _hideQueueIfEmpty(); showToast("Admitted");
}
function declineGuest(uid) {
  db.ref("joinRequests/" + meetingId + "/" + uid).update({ status: "declined" }).catch(() => {});
  setTimeout(() => db.ref("joinRequests/" + meetingId + "/" + uid).remove(), 3000);
  document.getElementById("req-" + uid)?.remove(); _hideQueueIfEmpty();
}
function _hideQueueIfEmpty() { const c = document.getElementById("admissionQueue"); if (c?.children.length === 0) c.style.display = "none"; }

function hostMuteParticipant(uid) {
  if (!isHost) return;
  const isMuted = participants[uid]?.audio === false;
  const action  = isMuted ? "unmute" : "mute";
  db.ref("hostCommands/" + meetingId + "/" + uid).set({
    action, ts: firebase.database.ServerValue.TIMESTAMP
  }).catch(() => {});
  showToast(isMuted ? "Requested unmute" : "Muting participant");
}

// ── Leave / End ───────────────────────────────────────────
async function leaveMeeting() {
  if (!confirm("Leave this meeting?")) return;
  if (recorder && recorder.isRecording) {
    const durationMs = recorder.durationMs;
    const blob = await recorder.stop();
    recorder = null;
    if (blob && blob.size > 0) _downloadRecording(blob, durationMs);
  }
  _broadcastAIActivity(null);
  await _cleanup();
  window.location.href = "dashboard.html";
}

async function endMeeting() {
  if (!isHost) return;
  if (!confirm("End this meeting for everyone?")) return;
  // Auto-download any active recording first
  if (recorder && recorder.isRecording) {
    const durationMs = recorder.durationMs;
    const blob = await recorder.stop();
    recorder   = null;
    if (blob && blob.size > 0) _downloadRecording(blob, durationMs);
  }
  await _finishEndMeeting();
}

async function _finishEndMeeting() {
  await triggerSummarize();
  if (transcription) await _persistTranscript(transcription.getFullText());
  db.ref("joinRequests/" + meetingId).remove();
  _broadcastAIActivity(null);
  if (_meetingRef) await _meetingRef.update({ status: "ended", endedAt: firebase.database.ServerValue.TIMESTAMP });
  await _cleanup();
  window.location.href = "dashboard.html";
}

async function _cleanup() {
  transcription?.stop();
  aiManager?.destroy();
  if (_meetingRef) _meetingRef.off();
  // Stop local mic stream used for recording
  webrtc?.localStream?.getTracks().forEach(t => t.stop());
  // Dispose Jitsi (handles all video/audio connections)
  if (jitsiApi) { try { jitsiApi.dispose(); } catch (_) {} jitsiApi = null; }
  // Remove Firebase presence so the people list updates immediately
  try { await db.ref("presence/" + meetingId + "/" + currentUser.uid).remove(); } catch (_) {}
}

// ── Timer ─────────────────────────────────────────────────
let _meetingStart = Date.now();
function startMeetingTimer() {
  setInterval(() => {
    const el = document.getElementById("meetingTimer");
    if (!el) return;
    const s   = Math.floor((Date.now() - _meetingStart) / 1000);
    const h   = Math.floor(s / 3600);
    const m   = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    const display = h > 0 ? `${h}:${m}:${sec}` : `${m}:${sec}`;
    (el.querySelector("span") || el).textContent = display;
  }, 1000);
}

// ── Utilities ─────────────────────────────────────────────
function copyMeetingLink() {
  const base = location.origin + location.pathname.replace("meeting.html", "");
  navigator.clipboard.writeText(base + "lobby.html?id=" + meetingId).then(() => showToast("Invite link copied!"));
}

function showMeetingError(msg) { const el = document.getElementById("meetingError"); if (el) { el.textContent = msg; el.style.display = "block"; } }

function showToast(msg) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function downloadTranscript() { _downloadText(transcription?.getFullText() || "", "transcript-" + meetingId + ".txt"); }
function downloadSummary()    { _downloadText(document.getElementById("summaryContent")?.innerText || "", "summary-" + meetingId + ".txt"); }
function _downloadText(text, filename) {
  Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: filename
  }).click();
}

function getInitials(name) {
  if (!name) return "?";
  return name.trim().split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2);
}
function _getTimestamp() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function escapeHtml(str) {
  return (str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function _markdownToHtml(text) {
  return text.replace(/\*\*(.*?)\*\*/g,"<strong>$1</strong>").replace(/\*(.*?)\*/g,"<em>$1</em>")
             .replace(/`(.*?)`/g,"<code>$1</code>").replace(/\n/g,"<br>");
}

// ── Fix: toggleAudio is called by the HTML button ─────────
// The function was named toggleMic() — this alias fixes it
function toggleAudio() { toggleMic(); }

// ── Host Settings ─────────────────────────────────────────
let _hostSettingsOpen = false;
let _customFields = [];

function openHostSettings() {
  if (!isHost) return;
  _hostSettingsOpen = true;
  document.getElementById("hostSettingsOverlay")?.classList.add("open");
  _loadHostSettings();
}

function closeHostSettings() {
  _hostSettingsOpen = false;
  document.getElementById("hostSettingsOverlay")?.classList.remove("open");
}

async function _loadHostSettings() {
  try {
    const snap = await db.ref("meetings/" + meetingId + "/settings").once("value");
    const s = snap.val() || {};
    _customFields = s.customFields || [];
    const perm = s.aiSummonPermission || "everyone";
    const el = document.getElementById("aiSummonPermission");
    if (el) el.value = perm;
    _renderCustomFieldRows();
  } catch (_) {}
}

function _renderCustomFieldRows() {
  const container = document.getElementById("customFieldsList");
  if (!container) return;
  container.innerHTML = "";
  _customFields.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "custom-field-row";
    row.innerHTML = `
      <input class="input" placeholder="Field label" value="${escapeHtml(f.label || "")}"
        oninput="window._customFields[${i}].label=this.value">
      <select class="input" style="max-width:110px"
        onchange="window._customFields[${i}].type=this.value">
        ${["text","email","phone","number","select"].map(t =>
          `<option value="${t}"${f.type===t?" selected":""}>${t}</option>`
        ).join("")}
      </select>
      <input class="input" placeholder="Options (comma-sep, if select)" value="${escapeHtml(f.options||"")}"
        style="max-width:130px" oninput="window._customFields[${i}].options=this.value">
      <button class="btn btn-danger btn-sm" onclick="window._removeCustomField(${i})">✕</button>`;
    container.appendChild(row);
  });
}

window._removeCustomField = function(i) {
  _customFields.splice(i, 1);
  _renderCustomFieldRows();
};

function addCustomField() {
  if (_customFields.length >= 10) { showToast("Maximum 10 custom fields"); return; }
  _customFields.push({ label: "", type: "text", options: "" });
  _renderCustomFieldRows();
}

async function saveHostSettings() {
  if (!isHost) return;
  const permEl = document.getElementById("aiSummonPermission");
  const perm   = permEl?.value || "everyone";
  const fields = _customFields.filter(f => f.label.trim());
  try {
    await db.ref("meetings/" + meetingId + "/settings").set({
      aiSummonPermission: perm,
      customFields: fields
    });
    showToast("Settings saved");
    closeHostSettings();
  } catch (e) {
    showToast("Failed to save settings");
  }
}

// ── Pet AI ────────────────────────────────────────────────
let petAI = null;
window.petAI = null;

function initPetAI() {
  if (typeof PetAI === "undefined") return;
  petAI = new PetAI(meetingId, {
    getTranscript:   () => transcription?.getFullText() || "",
    getSummary:      () => document.getElementById("summaryContent")?.innerText || "",
    isHost:          () => isHost,
    isAudioEnabled:  () => audioEnabled
  });
  window.petAI = petAI;
  petAI.startWakeWordDetection();
}

function togglePetAI() {
  if (!petAI) return;
  if (petAI.active) { petAI.stop(); }
  else {
    if (!petAI.canSummon()) { showToast("Pet AI is restricted by the host"); return; }
    petAI._summon();
  }
}

// ── Notification sound (waiting room) ────────────────────
function _playNotificationBeep() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = "sine"; osc.frequency.value = 880;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.45, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.65);
    osc.onended = () => ctx.close();
    // Second beep
    setTimeout(() => {
      try {
        const ctx2  = new (window.AudioContext || window.webkitAudioContext)();
        const osc2  = ctx2.createOscillator();
        const gain2 = ctx2.createGain();
        osc2.connect(gain2); gain2.connect(ctx2.destination);
        osc2.type = "sine"; osc2.frequency.value = 1100;
        gain2.gain.setValueAtTime(0, ctx2.currentTime);
        gain2.gain.linearRampToValueAtTime(0.35, ctx2.currentTime + 0.02);
        gain2.gain.exponentialRampToValueAtTime(0.001, ctx2.currentTime + 0.5);
        osc2.start(ctx2.currentTime);
        osc2.stop(ctx2.currentTime + 0.55);
        osc2.onended = () => ctx2.close();
      } catch (_) {}
    }, 200);
  } catch (_) {}
}

// ── Same-room echo fix: participant-selection dialog ──────
const _locallyMutedParticipants = new Set();

// Backward-compat alias kept so any old references still work
function toggleSameRoomMode() { openSameRoomDialog(); }

function openSameRoomDialog() {
  const overlay = document.getElementById("sameRoomOverlay");
  if (!overlay) return;
  const list = document.getElementById("sameRoomList");
  if (!list) return;
  list.innerHTML = "";
  const uids = Object.keys(participants).filter(uid => uid !== currentUser?.uid);
  if (uids.length === 0) {
    list.innerHTML = `<p style="color:var(--text-muted);font-size:.85rem;padding:8px 0;">No other participants yet.</p>`;
  } else {
    uids.forEach(uid => {
      const data     = participants[uid] || {};
      const isMuted  = _locallyMutedParticipants.has(uid);
      const initials = escapeHtml(getInitials(data.displayName || "?"));
      const item = document.createElement("div");
      item.className = "same-room-item";
      item.innerHTML = `
        <div class="same-room-avatar">${initials}</div>
        <div class="same-room-name">${escapeHtml(data.displayName || "Participant")}</div>
        <button class="btn btn-sm ${isMuted ? "btn-danger" : "btn-ghost"}" id="srmBtn-${uid}"
          onclick="toggleSameRoomParticipant('${uid}')">
          ${isMuted ? "🔇 Muted" : "🔊 Mute"}
        </button>`;
      list.appendChild(item);
    });
  }
  overlay.classList.add("open");
}

function closeSameRoomDialog() {
  document.getElementById("sameRoomOverlay")?.classList.remove("open");
}

function toggleSameRoomParticipant(uid) {
  const vid = document.getElementById("vid-" + uid);
  const btn = document.getElementById("srmBtn-" + uid);
  if (_locallyMutedParticipants.has(uid)) {
    _locallyMutedParticipants.delete(uid);
    if (vid) vid.muted = false;
    if (btn) { btn.className = "btn btn-sm btn-ghost"; btn.textContent = "🔊 Mute"; }
    showToast("Audio restored");
  } else {
    _locallyMutedParticipants.add(uid);
    if (vid) vid.muted = true;
    if (btn) { btn.className = "btn btn-sm btn-danger"; btn.textContent = "🔇 Muted"; }
    showToast("Locally muted — prevents echo");
  }
}

// ── AI Terminal ────────────────────────────────────────────
function openAITerminal() {
  const overlay = document.getElementById("aiTerminalOverlay");
  if (overlay) overlay.classList.add("visible");
  setTimeout(() => document.getElementById("aiInput")?.focus(), 100);
}

function closeAITerminal() {
  const overlay = document.getElementById("aiTerminalOverlay");
  if (overlay) overlay.classList.remove("visible");
}

function stopAI() {
  aiManager?.stopSpeaking();
  const indicator = document.getElementById("aiTypingIndicator");
  if (indicator) indicator.style.display = "none";
}

function continueAI() {
  if (!aiManager) return;
  sendAIMessage("Continue");
}

async function sendAIMessage(overrideText) {
  const input    = document.getElementById("aiInput");
  const chatLog  = document.getElementById("aiChatLog");
  const indicator = document.getElementById("aiTypingIndicator");
  const text = overrideText || (input?.value || "").trim();
  if (!text) return;
  if (input && !overrideText) input.value = "";

  // Append user bubble
  if (chatLog) {
    const userBubble = document.createElement("div");
    userBubble.className = "ai-bubble ai-bubble-user";
    userBubble.innerHTML = `<div class="ai-bubble-text">${escapeHtml(text)}</div>`;
    chatLog.appendChild(userBubble);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  if (indicator) indicator.style.display = "block";
  _broadcastAIActivity(true);

  try {
    if (!aiManager) {
      setupAI();
      if (!aiManager) throw new Error("AI not ready");
    }
    const transcript = transcription?.getFullText() || "";
    const reply = await aiManager.chat(text, transcript);
    if (chatLog) {
      const aiBubble = document.createElement("div");
      aiBubble.className = "ai-bubble ai-bubble-ai";
      aiBubble.innerHTML = `
        <div class="ai-bubble-label">🤖 MeetAI (Mistral)</div>
        <div class="ai-bubble-text">${_markdownToHtml(escapeHtml(reply))}</div>`;
      chatLog.appendChild(aiBubble);
      chatLog.scrollTop = chatLog.scrollHeight;
    }
    if (indicator) indicator.style.display = "none";

    // Mute summoner's own mic while AI speaks, just like other participants
    const _summonerMicWasOn = audioEnabled;
    if (audioEnabled) {
      audioEnabled = false;
      webrtc?.setAudioEnabled(false);
      if (typeof _syncMicIcon === "function") _syncMicIcon(false);
    }
    // Broadcast speaking — triggers mic mute on all other clients via setupAIBroadcastListener
    _broadcastAISpeaking(true);
    aiManager.speak(reply, () => {
      // Speech ended — clear speaking state and restore summoner mic
      _broadcastAISpeaking(false);
      _broadcastAIActivity(false);
      if (_summonerMicWasOn && !audioEnabled) {
        audioEnabled = true;
        webrtc?.setAudioEnabled(true);
        if (typeof _syncMicIcon === "function") _syncMicIcon(true);
        showToast("✦ MeetAI finished — mic restored");
      }
    });
  } catch (err) {
    if (indicator) indicator.style.display = "none";
    _broadcastAIActivity(false);
    _broadcastAISpeaking(false);
    if (chatLog) {
      const errBubble = document.createElement("div");
      errBubble.className = "ai-bubble ai-bubble-ai";
      errBubble.innerHTML = `<div class="ai-bubble-text">❌ ${escapeHtml(err.message)}</div>`;
      chatLog.appendChild(errBubble);
    }
  }
}

// ── Summarize transcript ───────────────────────────────────
async function triggerSummarize() {
  if (!aiManager) setupAI();
  const btn     = document.getElementById("summarizeBtn");
  const content = document.getElementById("summaryContent");
  if (btn) { btn.textContent = "Summarizing…"; btn.disabled = true; }
  if (content) content.innerHTML = `<span style="color:var(--text-muted)">Generating summary…</span>`;
  try {
    const transcript = transcription?.getFullText() || "";
    const mode = aiManager?.bookMode ? "book" : "standard";
    const summary = await aiManager.summarize(transcript, mode);
    if (content) content.innerHTML = _markdownToHtml(escapeHtml(summary));
    aiManager?.saveSummaryToRTDB?.(summary, mode);
  } catch (err) {
    if (content) content.innerHTML = `<span style="color:var(--danger)">❌ ${escapeHtml(err.message)}</span>`;
  } finally {
    if (btn) { btn.textContent = "Summarize Now"; btn.disabled = false; }
  }
}

// ── Persist transcript to RTDB on meeting end ──────────────
async function _persistTranscript(text) {
  if (!text || !meetingId) return;
  try {
    await db.ref("meetings/" + meetingId + "/transcript").set({
      text,
      savedAt: firebase.database.ServerValue.TIMESTAMP
    });
  } catch (_) {}
}

// ── Host command listener (mute / unmute from host) ───────
function setupHostCommandListener() {
  db.ref("hostCommands/" + meetingId + "/" + currentUser.uid).on("value", snap => {
    const cmd = snap.val();
    if (!cmd || !cmd.action) return;
    if (cmd.action === "mute" && audioEnabled) {
      audioEnabled = false;
      webrtc?.setAudioEnabled(false);
      _syncMicIcon(false);
      showToast("🔇 Host muted your microphone");
    } else if (cmd.action === "unmute" && !audioEnabled) {
      audioEnabled = true;
      webrtc?.setAudioEnabled(true);
      _syncMicIcon(true);
      showToast("🎤 Host unmuted your microphone");
    }
    snap.ref.remove().catch(() => {});
  });
}

// ── Pet AI broadcast — sync AI activity to all participants ─
function setupPetAIBroadcast() {
  let _prevMicState = null;

  db.ref("petAIBroadcast/" + meetingId).on("value", snap => {
    const data = snap.val();

    if (!data || !data.active) {
      // AI stopped — remove banner and restore mic for non-summoner
      document.getElementById("petAIGlobalBanner")?.remove();
      document.querySelectorAll("#participantGrid .participant-tile").forEach(t => t.classList.remove("ai-speaking"));
      if (_prevMicState !== null) {
        audioEnabled = _prevMicState;
        webrtc?.setAudioEnabled(audioEnabled);
        _syncMicIcon(audioEnabled);
        _prevMicState = null;
      }
      return;
    }

    // Show banner for ALL participants
    _showPetAIGlobalBanner();
    document.querySelectorAll("#participantGrid .participant-tile").forEach(t => t.classList.add("ai-speaking"));

    // Non-summoner: mute mic so there's no background noise
    if (data.uid !== currentUser?.uid) {
      if (_prevMicState === null) _prevMicState = audioEnabled;
      if (audioEnabled) {
        audioEnabled = false;
        webrtc?.setAudioEnabled(false);
        _syncMicIcon(false);
        showToast("✦ Pet AI is speaking — mic paused");
      }
    }
  });

  // Play speech text on non-summoner devices so everyone can hear Pet AI
  db.ref("petAIBroadcast/" + meetingId + "/speech").on("value", snap => {
    const speechData = snap.val();
    if (!speechData || !speechData.text) return;
    db.ref("petAIBroadcast/" + meetingId).once("value", s => {
      const broadcast = s.val();
      if (!broadcast || !broadcast.active) return;
      if (broadcast.uid === currentUser?.uid) return; // summoner already hears via PetAI locally
      if (!("speechSynthesis" in window)) return;
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(speechData.text);
      utter.rate = 1.05; utter.pitch = 1.0; utter.volume = 1.0;
      const voices = window.speechSynthesis.getVoices();
      const voice  = voices.find(v => v.lang.startsWith("en") && v.localService)
                  || voices.find(v => v.lang.startsWith("en"));
      if (voice) utter.voice = voice;
      window.speechSynthesis.speak(utter);
    });
  });
}

function _showPetAIGlobalBanner() {
  if (document.getElementById("petAIGlobalBanner")) return;
  const banner = document.createElement("div");
  banner.id        = "petAIGlobalBanner";
  banner.className = "petai-global-banner";
  banner.innerHTML = `
    <div class="petai-global-orb-mini"></div>
    <span>✦ Pet AI is speaking — mics paused</span>
    <div class="petai-global-orb-mini"></div>`;
  document.body.appendChild(banner);
}
