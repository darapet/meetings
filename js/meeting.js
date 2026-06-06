// ============================================================
//  MEETING.JS — Core meeting orchestration (Realtime Database)
// ============================================================

let webrtc         = null;
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
//  MEETING RECORDER — with pause / resume + auto-download
// ============================================================
class MeetingRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.chunks        = [];
    this.isRecording   = false;
    this.isPaused      = false;
    this.canvas        = document.createElement("canvas");
    this.canvas.width  = 1280;
    this.canvas.height = 720;
    this.ctx           = this.canvas.getContext("2d");
    this.audioCtx      = null;
    this.dest          = null;
    this.animId        = null;
    this.audioSources  = new Map();
  }

  start(localStream, remoteStreamMap) {
    this.audioCtx = new AudioContext();
    this.dest     = this.audioCtx.createMediaStreamDestination();
    if (localStream) this._addAudio(localStream, "local");
    remoteStreamMap.forEach((stream, uid) => this._addAudio(stream, uid));
    this._drawLoop();

    const videoTrack  = this.canvas.captureStream(30).getVideoTracks()[0];
    const audioTracks = this.dest.stream.getAudioTracks();
    const combined    = new MediaStream(audioTracks.length ? [videoTrack, audioTracks[0]] : [videoTrack]);
    const mimeType    = ["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"]
      .find(t => MediaRecorder.isTypeSupported(t)) || "video/webm";

    this.chunks        = [];
    this.mediaRecorder = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 2_500_000 });
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

  _drawLoop() { this._drawFrame(); this.animId = requestAnimationFrame(() => this._drawLoop()); }

  _drawFrame() {
    const W = 1280, H = 720, ctx = this.ctx;
    ctx.fillStyle = "#0d0f14";
    ctx.fillRect(0, 0, W, H);
    const tiles = [...document.querySelectorAll("#participantGrid .participant-tile")];
    const count = tiles.length || 1;
    const cols  = count === 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 2 : 3;
    const rows  = Math.ceil(count / cols);
    const tw = W / cols, th = H / rows;
    tiles.forEach((tile, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const x = col * tw, y = row * th;
      ctx.fillStyle = "#1a1e2a";
      ctx.fillRect(x, y, tw, th);
      const vid = tile.querySelector("video");
      if (vid && vid.readyState >= 2 && vid.videoWidth > 0) {
        const scale = Math.max(tw / vid.videoWidth, th / vid.videoHeight);
        const dw = vid.videoWidth * scale, dh = vid.videoHeight * scale;
        ctx.save(); ctx.beginPath(); ctx.rect(x, y, tw, th); ctx.clip();
        ctx.drawImage(vid, x + (tw - dw) / 2, y + (th - dh) / 2, dw, dh);
        ctx.restore();
      }
      const nameEl = tile.querySelector(".tile-name");
      if (nameEl) {
        const name = nameEl.textContent.trim();
        ctx.font = "bold 14px Inter, sans-serif";
        const tw2 = ctx.measureText(name).width + 24;
        ctx.fillStyle = "rgba(0,0,0,0.62)";
        const lx = x + 10, ly = y + th - 36, lh = 26, r = 8;
        ctx.beginPath();
        ctx.moveTo(lx + r, ly); ctx.lineTo(lx + tw2 - r, ly);
        ctx.quadraticCurveTo(lx + tw2, ly, lx + tw2, ly + r);
        ctx.lineTo(lx + tw2, ly + lh - r);
        ctx.quadraticCurveTo(lx + tw2, ly + lh, lx + tw2 - r, ly + lh);
        ctx.lineTo(lx + r, ly + lh);
        ctx.quadraticCurveTo(lx, ly + lh, lx, ly + lh - r);
        ctx.lineTo(lx, ly + r);
        ctx.quadraticCurveTo(lx, ly, lx + r, ly);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.fillText(name, lx + 12, ly + lh - 7);
      }
    });
    // REC / PAUSED indicator
    if (this.isPaused) {
      ctx.fillStyle = "#f59e0b";
      ctx.font = "bold 13px Inter, sans-serif";
      ctx.fillText("⏸ PAUSED", W - 80, 27);
    } else if (Math.floor(Date.now() / 700) % 2 === 0) {
      ctx.fillStyle = "#ef4444";
      ctx.beginPath(); ctx.arc(W - 36, 22, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "bold 13px Inter, sans-serif"; ctx.fillText("REC", W - 24, 27);
    }
  }

  stop() {
    return new Promise(resolve => {
      if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") { resolve(null); return; }
      this.mediaRecorder.onstop = () => {
        if (this.animId) cancelAnimationFrame(this.animId);
        if (this.audioCtx) this.audioCtx.close().catch(() => {});
        this.isRecording = false;
        this.isPaused    = false;
        resolve(new Blob(this.chunks, { type: "video/webm" }));
      };
      // Resume first if paused, then stop (ensures all chunks are flushed)
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
    try { setupAIBroadcastListener(); } catch (e) { console.error("AI Broadcast:", e); }
    updateHostControls();
    startMeetingTimer();
    if (isHost) try { listenForJoinRequests(); } catch (e) { console.error("WaitingRoom:", e); }
    try { initPetAI(); } catch (e) { console.error("PetAI:", e); }
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
async function setupLocalMedia() {
  webrtc = new WebRTCManager(meetingId, currentUser.uid, onRemoteStream, onPeerLeft, onNetworkQuality);
  try {
    const stream = await webrtc.getLocalStream(true, true);
    attachLocalStream(stream);
  } catch (_) {
    try {
      const stream = await webrtc.getLocalStream(false, true);
      videoEnabled = false; attachLocalStream(stream);
      showToast("Camera unavailable — audio only.");
    } catch (e) { showMeetingError("Microphone access denied. Please allow it and reload."); }
  }
}

function attachLocalStream(stream) {
  addParticipantTile(currentUser.uid, currentUser.displayName, currentUser.photoURL, true, stream);
  const vidEl = document.getElementById("vid-" + currentUser.uid);
  if (vidEl) { vidEl.srcObject = stream; vidEl.muted = true; }
  if (typeof _syncCamIcon === "function") _syncCamIcon(videoEnabled);
  if (typeof _syncMicIcon === "function") _syncMicIcon(audioEnabled);
}

// ── Remote streams ────────────────────────────────────────
function onRemoteStream(peerId, stream) {
  remoteStreams.set(peerId, stream);
  if (recorder && recorder.isRecording) recorder.addRemoteStream(peerId, stream);
  db.ref("presence/" + meetingId + "/" + peerId).once("value", snap => {
    const data   = snap.val() || {};
    const wasNew = !participants[peerId];
    participants[peerId] = data;
    addParticipantTile(peerId, data.displayName || "Participant", data.photoURL || "", false, stream);
    if (wasNew && data.displayName) showToast("✦ " + data.displayName + " joined");
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
    if (!isLocal) vidEl.play().catch(() => _showTapToUnmute(uid));
  }
  _setTileVideoVisible(uid, isLocal ? videoEnabled : true);
  updateParticipantCount();
}

function _showTapToUnmute(uid) {
  const tile = document.getElementById("tile-" + uid);
  if (!tile || tile.querySelector(".tap-unmute")) return;
  const overlay = document.createElement("div");
  overlay.className = "tap-unmute"; overlay.textContent = "Tap to hear";
  overlay.onclick = () => { document.getElementById("vid-" + uid)?.play().catch(() => {}); overlay.remove(); };
  tile.appendChild(overlay);
}

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
    _setTileVideoVisible(uid, data.video !== false);
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
  item.className = "participant-item";
  const initials = escapeHtml(getInitials(name || "?"));
  const avatar   = photo
    ? `<img src="${escapeHtml(photo)}" class="p-avatar-img" alt="">`
    : `<div class="p-avatar-initials">${initials}</div>`;
  const netQ = data.networkQuality || "good";
  const netBadge = netQ !== "good"
    ? `<span class="p-net-badge net-${netQ}" title="Network: ${netQ}">${_signalBarsHtml(netQ)}</span>`
    : "";
  item.innerHTML = `
    <div class="p-avatar">${avatar}</div>
    <div class="p-info">
      <div class="p-name">${escapeHtml(name || "Participant")}${isLocal ? " <span class='p-you'>(You)</span>" : ""}</div>
      <div class="p-sub">${isLocal ? "Host" : (data.audio === false ? "Muted" : "")}</div>
    </div>
    ${netBadge}
    ${isLocal ? "" : `<button class="btn-icon p-mute-btn" onclick="hostMuteParticipant('${uid}')" title="Mute">
      <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      </svg>
    </button>`}`;
  list.appendChild(item);
}

// ── WebRTC setup ──────────────────────────────────────────
function setupWebRTC() {
  if (!webrtc) return;
  webrtc.joinRoom();
}

// ── Transcription ─────────────────────────────────────────
function setupTranscription() {
  if (typeof LiveTranscription === "undefined") return;
  transcription = new LiveTranscription(
    chunk => _onTranscriptChunk(chunk),
    err   => console.warn("Transcription:", err),
    status => _onTranscriptStatus(status)
  );
  if (transcription.isSupported()) transcription.start();
}

let _interimEl = null;
function _onTranscriptChunk({ type, text, fullText }) {
  const liveEl = document.getElementById("liveTranscript");
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
}

// ── Chat ──────────────────────────────────────────────────
function setupChat() {
  const chatRef  = db.ref("chat/" + meetingId);
  const chatList = document.getElementById("chatMessages");
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
  db.ref("aiActivity/" + meetingId).on("value", snap => {
    const data   = snap.val();
    const banner = document.getElementById("aiActivityBanner");
    if (!data || !data.active || !data.uid) { if (banner) banner.style.display = "none"; return; }
    if (data.uid === currentUser.uid)      { if (banner) banner.style.display = "none"; return; }
    db.ref("presence/" + meetingId + "/" + data.uid).once("value", pSnap => {
      const name = pSnap.val()?.displayName || "Someone";
      if (banner) { banner.textContent = "✦ " + name + " is using AI…"; banner.style.display = "flex"; }
    });
  });
}

function _broadcastAIActivity(active) {
  db.ref("aiActivity/" + meetingId).set(
    active ? { uid: currentUser.uid, active: true, ts: firebase.database.ServerValue.TIMESTAMP } : null
  ).catch(() => {});
}

// ── Controls ──────────────────────────────────────────────
function toggleMic() {
  audioEnabled = !audioEnabled;
  webrtc?.setAudioEnabled(audioEnabled);
  if (typeof _syncMicIcon === "function") _syncMicIcon(audioEnabled);
}

function toggleVideo() {
  videoEnabled = !videoEnabled;
  webrtc?.setVideoEnabled(videoEnabled);
  _setTileVideoVisible(currentUser.uid, videoEnabled);
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
  if (!isHost || !webrtc?.localStream) { showToast("Camera/mic not ready yet."); return; }
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
  const blob = await recorder.stop();
  recorder = null;
  if (typeof _syncRecordIcon === "function") _syncRecordIcon(false);
  _syncPauseIcon(false, false);
  const pw = document.getElementById("pauseRecordWrap");
  if (pw) pw.style.display = "none";
  if (blob && blob.size > 0) {
    _downloadRecording(blob);   // ← auto-download immediately, no dialog
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

function _downloadRecording(blob) {
  const name = (meetingData.name || "meeting").replace(/\s+/g, "-").toLowerCase();
  const ts   = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: name + "_" + ts + ".webm" });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
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
  db.ref("presence/" + meetingId + "/" + uid + "/forceMuted").set(true).catch(() => {});
  showToast("Muted participant");
}

// ── Leave / End ───────────────────────────────────────────
async function leaveMeeting() {
  if (!confirm("Leave this meeting?")) return;
  if (recorder && recorder.isRecording) {
    const blob = await recorder.stop();
    if (blob && blob.size > 0) _downloadRecording(blob);
    recorder = null;
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
    const blob = await recorder.stop();
    recorder   = null;
    if (blob && blob.size > 0) _downloadRecording(blob);
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
  if (webrtc) await webrtc.leave();
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

// ── Same-room echo fix: mute/unmute all remote audio ──────
let _sameRoomMode = false;
function toggleSameRoomMode() {
  _sameRoomMode = !_sameRoomMode;
  document.querySelectorAll(".remote-video").forEach(v => {
    if (v.tagName === "VIDEO") v.muted = _sameRoomMode;
  });
  // Also get any video elements inside tile wrappers
  document.querySelectorAll("#videoGrid video:not(#localVideo)").forEach(v => {
    v.muted = _sameRoomMode;
  });
  const btn = document.getElementById("sameRoomBtn");
  if (btn) {
    btn.classList.toggle("active", _sameRoomMode);
    btn.title = _sameRoomMode ? "Same-Room Mode ON (remote audio muted)" : "Same-Room Mode (mute remote audio)";
  }
  showToast(_sameRoomMode
    ? "Same-room mode ON — remote audio muted to prevent echo"
    : "Same-room mode OFF — remote audio restored");
}
