// ============================================================
//  MEETING.JS — Core meeting orchestration
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
let remoteStreams   = new Map(); // peerId -> MediaStream (for audio mixing)

// ============================================================
//  MEETING RECORDER — composite canvas + Web Audio mixer
// ============================================================
class MeetingRecorder {
  constructor() {
    this.mediaRecorder  = null;
    this.chunks         = [];
    this.isRecording    = false;
    this.canvas         = document.createElement("canvas");
    this.canvas.width   = 1280;
    this.canvas.height  = 720;
    this.ctx            = this.canvas.getContext("2d");
    this.audioCtx       = null;
    this.dest           = null;
    this.animId         = null;
    this.audioSources   = new Map();
  }

  start(localStream, remoteStreamMap) {
    // ── Web Audio context for mixing all participants ────────
    this.audioCtx = new AudioContext();
    this.dest     = this.audioCtx.createMediaStreamDestination();

    if (localStream)  this._addAudio(localStream, "local");
    remoteStreamMap.forEach((stream, uid) => this._addAudio(stream, uid));

    // ── Start canvas draw loop ───────────────────────────────
    this._drawLoop();

    // ── Combine canvas video + mixed audio ──────────────────
    const videoTrack  = this.canvas.captureStream(30).getVideoTracks()[0];
    const audioTracks = this.dest.stream.getAudioTracks();
    const combined    = new MediaStream(audioTracks.length
      ? [videoTrack, audioTracks[0]]
      : [videoTrack]);

    const mimeType = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ].find(t => MediaRecorder.isTypeSupported(t)) || "video/webm";

    this.chunks        = [];
    this.mediaRecorder = new MediaRecorder(combined, {
      mimeType,
      videoBitsPerSecond: 2_500_000
    });
    this.mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.start(1000);
    this.isRecording = true;
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

  addRemoteStream(uid, stream) {
    if (this.isRecording) this._addAudio(stream, uid);
  }

  _drawLoop() {
    this._drawFrame();
    this.animId = requestAnimationFrame(() => this._drawLoop());
  }

  _drawFrame() {
    const W = 1280, H = 720;
    const ctx = this.ctx;

    // Background
    ctx.fillStyle = "#0d0f14";
    ctx.fillRect(0, 0, W, H);

    // Collect participant tiles
    const tiles = [...document.querySelectorAll("#participantGrid .participant-tile")];
    const count = tiles.length || 1;
    const cols  = count === 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 2 : 3;
    const rows  = Math.ceil(count / cols);
    const tw    = W / cols;
    const th    = H / rows;

    tiles.forEach((tile, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x   = col * tw;
      const y   = row * th;

      // Tile background
      ctx.fillStyle = "#1a1e2a";
      ctx.fillRect(x, y, tw, th);

      const vid = tile.querySelector("video");
      if (vid && vid.readyState >= 2 && vid.videoWidth > 0) {
        // Cover-fit the video into the tile slot
        const vw    = vid.videoWidth;
        const vh    = vid.videoHeight;
        const scale = Math.max(tw / vw, th / vh);
        const dw    = vw * scale;
        const dh    = vh * scale;
        const dx    = x + (tw - dw) / 2;
        const dy    = y + (th - dh) / 2;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, tw, th);
        ctx.clip();
        ctx.drawImage(vid, dx, dy, dw, dh);
        ctx.restore();
      }

      // Name label
      const nameEl = tile.querySelector(".tile-name");
      if (nameEl) {
        const name = nameEl.textContent.trim();
        ctx.font      = "bold 14px Inter, sans-serif";
        const textW   = ctx.measureText(name).width;
        const padX    = 12, padY = 6, radius = 8;
        const lx      = x + 10;
        const ly      = y + th - 36;
        const lw      = textW + padX * 2;
        const lh      = 26;

        ctx.fillStyle = "rgba(0,0,0,0.62)";
        ctx.beginPath();
        ctx.moveTo(lx + radius, ly);
        ctx.lineTo(lx + lw - radius, ly);
        ctx.quadraticCurveTo(lx + lw, ly, lx + lw, ly + radius);
        ctx.lineTo(lx + lw, ly + lh - radius);
        ctx.quadraticCurveTo(lx + lw, ly + lh, lx + lw - radius, ly + lh);
        ctx.lineTo(lx + radius, ly + lh);
        ctx.quadraticCurveTo(lx, ly + lh, lx, ly + lh - radius);
        ctx.lineTo(lx, ly + radius);
        ctx.quadraticCurveTo(lx, ly, lx + radius, ly);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = "#ffffff";
        ctx.fillText(name, lx + padX, ly + lh - padY);
      }
    });

    // REC indicator (top-right)
    const now = Date.now();
    if (Math.floor(now / 700) % 2 === 0) {
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.arc(W - 36, 22, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 13px Inter, sans-serif";
    ctx.fillText("REC", W - 24, 27);
  }

  stop() {
    return new Promise(resolve => {
      if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") {
        resolve(null);
        return;
      }
      this.mediaRecorder.onstop = () => {
        if (this.animId) cancelAnimationFrame(this.animId);
        if (this.audioCtx) this.audioCtx.close().catch(() => {});
        const blob = new Blob(this.chunks, { type: "video/webm" });
        this.isRecording = false;
        resolve(blob);
      };
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
    showAuthSpinner();
    try {
      await loadMeetingData();
      await setupLocalMedia();
      setupWebRTC();
      setupTranscription();
      setupAI();
      setupChat();
      setupPresenceDisplay();
      updateHostControls();
      startMeetingTimer();
      if (isHost) listenForJoinRequests();
    } catch (err) {
      showMeetingError("Failed to start: " + err.message);
    } finally {
      hideAuthSpinner();
    }
  });
}

// ── Load meeting data ──────────────────────────────────────
async function loadMeetingData() {
  const snap = await firestore.collection("meetings").doc(meetingId).get();
  if (!snap.exists) {
    showMeetingError("Meeting not found.");
    setTimeout(() => { window.location.href = "dashboard.html"; }, 3000);
    return;
  }
  meetingData = snap.data();
  isHost = meetingData.hostId === currentUser.uid;

  document.title = `${meetingData.name || "Meeting"} — MeetAI`;
  document.getElementById("meetingTitle").textContent     = meetingData.name || "Meeting";
  document.getElementById("meetingIdDisplay").textContent = meetingId;

  await firestore.collection("meetings").doc(meetingId).update({
    participants: firebase.firestore.FieldValue.arrayUnion(currentUser.uid),
    lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
    status:       "active"
  });

  // Watch for host ending the meeting
  firestore.collection("meetings").doc(meetingId).onSnapshot(snap => {
    if (!snap.exists) return;
    const d = snap.data();
    if (d.status === "ended" && !isHost) {
      showMeetingError("The host has ended this meeting.");
      setTimeout(() => { window.location.href = "dashboard.html"; }, 3000);
    }
  });
}

// ── Local media ────────────────────────────────────────────
async function setupLocalMedia() {
  webrtc = new WebRTCManager(meetingId, currentUser.uid, onRemoteStream, onPeerLeft);
  try {
    const stream = await webrtc.getLocalStream(true, true);
    attachLocalStream(stream);
  } catch (_) {
    try {
      const stream = await webrtc.getLocalStream(false, true);
      videoEnabled = false;
      attachLocalStream(stream);
      showToast("📷 Camera unavailable — audio only.");
    } catch (e) {
      showMeetingError("Microphone access denied. Please allow it and reload.");
    }
  }
}

function attachLocalStream(stream) {
  const vid = document.getElementById("localVideo");
  if (vid) { vid.srcObject = stream; vid.muted = true; }
  addParticipantTile(currentUser.uid, currentUser.displayName, currentUser.photoURL, true);
  updateVideoBtn();
}

// ── Remote streams ─────────────────────────────────────────
function onRemoteStream(peerId, stream) {
  remoteStreams.set(peerId, stream);
  if (recorder && recorder.isRecording) recorder.addRemoteStream(peerId, stream);

  db.ref(`presence/${meetingId}/${peerId}`).once("value", snap => {
    const data = snap.val() || {};
    participants[peerId] = data;
    addParticipantTile(peerId, data.displayName || "Participant", data.photoURL || "", false, stream);
    updateParticipantSidebar();
  });
}

function onPeerLeft(peerId) {
  remoteStreams.delete(peerId);
  removeParticipantTile(peerId);
  delete participants[peerId];
  updateParticipantCount();
  updateParticipantSidebar();
}

// ── Participant grid ───────────────────────────────────────
function addParticipantTile(uid, name, photo, isLocal, stream) {
  const grid = document.getElementById("participantGrid");
  if (!grid) return;
  let tile = document.getElementById(`tile-${uid}`);
  if (!tile) {
    tile = document.createElement("div");
    tile.id        = `tile-${uid}`;
    tile.className = "participant-tile";
    const hostCrown = (uid === meetingData.hostId) ? " 👑" : "";
    tile.innerHTML = `
      <video autoplay playsinline ${isLocal ? "muted" : ""} id="vid-${uid}"></video>
      <div class="tile-avatar" id="avatar-${uid}">
        ${photo ? `<img src="${photo}" alt="">` : `<span>${escapeHtml(getInitials(name))}</span>`}
      </div>
      <div class="tile-name">${escapeHtml(name)}${isLocal ? " (You)" : hostCrown}</div>
      <div class="tile-status">
        <span class="status-icon" id="mic-${uid}">🎤</span>
        <span class="status-icon" id="cam-${uid}">📷</span>
      </div>`;
    grid.appendChild(tile);
  }
  const vidEl = document.getElementById(`vid-${uid}`);
  if (stream && vidEl) vidEl.srcObject = stream;
  _setTileVideoVisible(uid, isLocal ? videoEnabled : true);
  updateParticipantCount();
}

function removeParticipantTile(uid) {
  document.getElementById(`tile-${uid}`)?.remove();
  updateParticipantCount();
}

function _setTileVideoVisible(uid, visible) {
  const vid    = document.getElementById(`vid-${uid}`);
  const avatar = document.getElementById(`avatar-${uid}`);
  if (!vid || !avatar) return;
  vid.style.display    = visible ? "block" : "none";
  avatar.style.display = visible ? "none"  : "flex";
}

function updateParticipantCount() {
  const count = document.querySelectorAll(".participant-tile").length;
  const el    = document.getElementById("participantCount");
  if (el) el.textContent = count;
}

// ── Presence live-sync ─────────────────────────────────────
function setupPresenceDisplay() {
  const presRef = db.ref(`presence/${meetingId}`);

  presRef.on("child_added", snap => {
    const uid  = snap.key;
    const data = snap.val() || {};
    if (uid !== currentUser.uid) {
      participants[uid] = data;
      updateParticipantSidebar();
    }
  });

  presRef.on("child_changed", snap => {
    const uid  = snap.key;
    const data = snap.val() || {};
    participants[uid] = data;
    const micIcon = document.getElementById(`mic-${uid}`);
    const camIcon = document.getElementById(`cam-${uid}`);
    if (micIcon) micIcon.style.opacity = data.audio === false ? "0.3" : "1";
    if (camIcon) camIcon.style.opacity = data.video === false ? "0.3" : "1";
    _setTileVideoVisible(uid, data.video !== false);
    // Raise hand badge
    const tile = document.getElementById(`tile-${uid}`);
    if (tile) {
      const existing = tile.querySelector(".hand-badge");
      if (data.handRaised && !existing) {
        const b = document.createElement("div");
        b.className = "hand-badge";
        b.style.cssText = "position:absolute;top:8px;left:8px;font-size:1.1rem;background:rgba(0,0,0,.55);border-radius:6px;padding:2px 6px;z-index:2;";
        b.textContent = "✋";
        tile.appendChild(b);
        showToast(`✋ ${data.displayName || "Someone"} raised their hand`);
      } else if (!data.handRaised && existing) {
        existing.remove();
      }
    }
    updateParticipantSidebar();
  });

  presRef.on("child_removed", snap => {
    if (snap.key !== currentUser.uid) {
      delete participants[snap.key];
      updateParticipantSidebar();
    }
  });
}

// ── Sidebar people list ────────────────────────────────────
function updateParticipantSidebar() {
  const list = document.getElementById("participantsList");
  if (!list) return;
  list.innerHTML = "";
  _appendParticipantItem(list, currentUser.uid, currentUser.displayName, currentUser.photoURL, true);
  Object.entries(participants).forEach(([uid, data]) => {
    if (uid !== currentUser.uid) _appendParticipantItem(list, uid, data.displayName, data.photoURL, false, data);
  });
}

function _appendParticipantItem(container, uid, name, photo, isMe, data = {}) {
  const div = document.createElement("div");
  div.className = "participant-list-item";
  const hostBadge = uid === meetingData.hostId ? `<span class="badge badge-accent" style="font-size:.65rem;padding:2px 7px;">Host</span>` : "";
  div.innerHTML = `
    <div class="avatar-sm">${photo ? `<img src="${photo}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">` : escapeHtml(getInitials(name || "?"))}</div>
    <div style="flex:1;min-width:0;">
      <div class="p-name">${escapeHtml(name || "Participant")}${isMe ? " (You)" : ""} ${hostBadge}</div>
      <div class="p-role">${data.audio===false?"🔇":"🎤"} ${data.video===false?"📷🚫":"📷"} ${data.handRaised?"✋":""}</div>
    </div>`;
  container.appendChild(div);
}

// ── WebRTC ─────────────────────────────────────────────────
function setupWebRTC() { webrtc.joinRoom(); }

// ── Transcription ──────────────────────────────────────────
function setupTranscription() {
  transcription = new LiveTranscription(onTranscriptChunk, onTranscriptError, onTranscriptStatus);
  if (!transcription.isSupported()) {
    const panel = document.getElementById("transcriptContent");
    if (panel) panel.innerHTML = `<div class="transcript-unsupported">⚠️ Live transcription requires Chrome or Edge.</div>`;
    return;
  }
  transcription.start();
  if (webrtc?.localStream && aiManager) {
    aiManager.attachVADInterrupt(webrtc.localStream,
      () => showAIStatus("⏸ AI paused — you're speaking"),
      () => showAIStatus(""));
  }
}

let _interimEl = null;
let _finalLineCount = 0;

function onTranscriptChunk({ type, text, fullText }) {
  const panel = document.getElementById("transcriptContent");
  if (!panel) return;
  if (type === "interim") {
    if (!_interimEl) { _interimEl = document.createElement("span"); _interimEl.className = "transcript-interim"; panel.appendChild(_interimEl); }
    _interimEl.textContent = text;
  } else if (type === "final") {
    _interimEl?.remove(); _interimEl = null;
    const line = document.createElement("p");
    line.className = "transcript-line";
    line.innerHTML = `<span class="ts-time">${_getTimestamp()}</span> ${escapeHtml(text)}`;
    panel.appendChild(line);
    panel.scrollTop = panel.scrollHeight;
    if (++_finalLineCount % 10 === 0) _persistTranscript(fullText);
  } else if (type === "error") {
    _interimEl?.remove(); _interimEl = null;
    const errLine = document.createElement("p");
    errLine.className = "transcript-error-line";
    errLine.textContent = text;
    panel.appendChild(errLine);
  }
}

function onTranscriptError(msg) {
  const el = document.getElementById("transcriptStatus");
  if (el) el.textContent = "❌ " + msg;
}

function onTranscriptStatus(status) {
  const el = document.getElementById("transcriptStatus");
  if (!el) return;
  const labels = { listening:"🔴 Live", paused:"⏸ Paused", stopped:"⬛ Stopped", silence:"🔇 Waiting…", error:"❌ Error" };
  el.textContent = labels[status] || status;
}

async function _persistTranscript(fullText) {
  if (!fullText || !meetingId) return;
  try { await firestore.collection("meetings").doc(meetingId).update({ transcript: fullText, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }); } catch (_) {}
}

// ── AI ─────────────────────────────────────────────────────
function setupAI() {
  aiManager = new AIManager(meetingId, currentUser.uid);
  setInterval(autoSummarize, 5 * 60 * 1000);
}

function openAITerminal() {
  document.getElementById("aiTerminalOverlay").classList.add("visible");
  document.getElementById("aiInput")?.focus();
}

function closeAITerminal() {
  document.getElementById("aiTerminalOverlay").classList.remove("visible");
  aiManager.stopSpeaking();
}

async function sendAIMessage() {
  const input = document.getElementById("aiInput");
  const text  = (input?.value || "").trim();
  if (!text) return;
  input.value = "";
  addAIChatBubble("user", text);
  showAITyping(true);
  const reply = await aiManager.chat(text, transcription?.getFullText() || "");
  aiLastResponse = reply;
  showAITyping(false);
  addAIChatBubble("ai", reply);
  aiManager.speak(reply, () => showAIStatus(""));
  showAIStatus("🔊 MeetAI is speaking…");
}

function addAIChatBubble(role, text) {
  const log = document.getElementById("aiChatLog");
  if (!log) return;
  const div = document.createElement("div");
  div.className = `ai-bubble ai-bubble-${role}`;
  div.innerHTML = `
    <div class="ai-bubble-label">${role === "ai" ? "🤖 MeetAI (Mistral)" : "👤 You"}</div>
    <div class="ai-bubble-text">${_markdownToHtml(escapeHtml(text))}</div>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function showAITyping(show) { const el = document.getElementById("aiTypingIndicator"); if (el) el.style.display = show ? "block" : "none"; }
function showAIStatus(msg)  { const el = document.getElementById("aiStatusBar"); if (el) el.textContent = msg; }
function stopAI()    { aiManager.stopSpeaking(); showAIStatus("⏹ Stopped"); }
function continueAI(){ if (aiLastResponse) { aiManager.speak(aiLastResponse, () => showAIStatus("")); showAIStatus("🔊 Resuming…"); } }

async function autoSummarize() {
  const t = transcription?.getFullText() || "";
  if (t.length < 100) return;
  const mode    = document.getElementById("bookModeToggle")?.checked ? "book" : "standard";
  const summary = await aiManager.summarize(t, mode);
  setSummaryPanel(summary);
  aiManager.saveSummaryToFirestore(summary, mode);
}

async function triggerSummarize() {
  const btn = document.getElementById("summarizeBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Summarizing…"; }
  const t    = transcription?.getFullText() || "";
  const mode = document.getElementById("bookModeToggle")?.checked ? "book" : "standard";
  const summary = await aiManager.summarize(t, mode);
  setSummaryPanel(summary);
  aiManager.saveSummaryToFirestore(summary, mode);
  if (btn) { btn.disabled = false; btn.textContent = "Summarize Now"; }
}

function setSummaryPanel(text) {
  const el = document.getElementById("summaryContent");
  if (el) el.innerHTML = _markdownToHtml(escapeHtml(text));
}

// ── Chat ───────────────────────────────────────────────────
function setupChat() {
  firestore.collection("meetings").doc(meetingId).collection("chat").orderBy("ts")
    .onSnapshot(snap => snap.docChanges().forEach(c => { if (c.type === "added") _renderChatMessage(c.doc.data()); }));
}

async function sendChatMessage() {
  const input = document.getElementById("chatInput");
  const text  = (input?.value || "").trim();
  if (!text) return;
  input.value = "";
  await firestore.collection("meetings").doc(meetingId).collection("chat").add({
    uid: currentUser.uid, displayName: currentUser.displayName || "Anonymous",
    text, ts: firebase.firestore.FieldValue.serverTimestamp()
  });
}

function _renderChatMessage(data) {
  const log = document.getElementById("chatLog");
  if (!log) return;
  const div = document.createElement("div");
  div.className = `chat-msg ${data.uid === currentUser.uid ? "chat-mine" : ""}`;
  div.innerHTML = `<span class="chat-name">${escapeHtml(data.displayName)}</span><span class="chat-text">${escapeHtml(data.text)}</span>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ── Controls ───────────────────────────────────────────────
function toggleAudio() {
  audioEnabled = !audioEnabled;
  webrtc.setAudioEnabled(audioEnabled);
  const btn = document.getElementById("toggleMicBtn");
  if (btn) { btn.textContent = audioEnabled ? "🎤" : "🔇"; btn.classList.toggle("control-off", !audioEnabled); }
}

function toggleVideo() {
  videoEnabled = !videoEnabled;
  webrtc.setVideoEnabled(videoEnabled);
  _setTileVideoVisible(currentUser.uid, videoEnabled);
  updateVideoBtn();
}

function updateVideoBtn() {
  const btn = document.getElementById("toggleCamBtn");
  if (btn) { btn.textContent = videoEnabled ? "📷" : "📷🚫"; btn.classList.toggle("control-off", !videoEnabled); }
}

// ── Host controls ──────────────────────────────────────────
function updateHostControls() {
  const panel   = document.getElementById("hostControls");
  const recBtn  = document.getElementById("recordBtn");
  if (panel)  panel.style.display  = isHost ? "flex"  : "none";
  if (recBtn) recBtn.style.display = isHost ? "flex"  : "none";
}

function toggleAIToolsVisibility() {
  aiToolsVisible = !aiToolsVisible;
  document.querySelectorAll(".ai-tools-panel").forEach(p => {
    p.style.visibility    = aiToolsVisible ? "visible" : "hidden";
    p.style.pointerEvents = aiToolsVisible ? "auto"    : "none";
  });
  const btn = document.getElementById("toggleAIVisBtn");
  if (btn) btn.textContent = aiToolsVisible ? "🙈 Hide AI Tools" : "👁 Show AI Tools";
  firestore.collection("meetings").doc(meetingId).update({ aiToolsHidden: !aiToolsVisible }).catch(() => {});
}

// ── Recording ──────────────────────────────────────────────
function toggleRecording() {
  if (!recorder || !recorder.isRecording) {
    startRecording();
  } else {
    stopRecordingAndSave();
  }
}

function startRecording() {
  if (!isHost) return;
  if (!webrtc?.localStream) { showToast("⚠️ Camera/mic not ready yet."); return; }

  recorder = new MeetingRecorder();
  const started = recorder.start(webrtc.localStream, remoteStreams);
  if (!started) { showToast("⚠️ Recording not supported in this browser."); return; }

  const btn = document.getElementById("recordBtn");
  if (btn) {
    btn.classList.add("recording");
    btn.title = "Stop Recording";
    const label = btn.closest("[data-rec-wrap]")?.querySelector(".control-btn-label");
    if (label) label.textContent = "Stop Rec";
  }
  showToast("🔴 Recording started");
}

async function stopRecordingAndSave() {
  if (!recorder) return null;
  const blob = await recorder.stop();
  recorder   = null;

  const btn = document.getElementById("recordBtn");
  if (btn) {
    btn.classList.remove("recording");
    btn.title = "Start Recording";
    const label = btn.closest("[data-rec-wrap]")?.querySelector(".control-btn-label");
    if (label) label.textContent = "Record";
  }

  if (blob && blob.size > 0) {
    showToast("⏹ Recording stopped");
    return blob;
  }
  return null;
}

function _downloadRecording(blob) {
  const name = (meetingData.name || "meeting").replace(/\s+/g, "-").toLowerCase();
  const ts   = new Date().toISOString().slice(0,19).replace(/:/g,"-");
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), {
    href:     url,
    download: `${name}_${ts}.webm`
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── WAITING ROOM — Host: listen for join requests ──────────
function listenForJoinRequests() {
  const reqRef = db.ref(`joinRequests/${meetingId}`);
  reqRef.on("child_added", snap => {
    const data = snap.val();
    if (!data || data.status !== "pending") return;
    showAdmissionRequest(snap.key, data);
  });
  reqRef.orderByChild("status").equalTo("pending").once("value", snap => {
    snap.forEach(child => showAdmissionRequest(child.key, child.val()));
  });
}

function showAdmissionRequest(uid, data) {
  if (document.getElementById(`req-${uid}`)) return;
  const container = document.getElementById("admissionQueue");
  if (!container) return;
  const card = document.createElement("div");
  card.id        = `req-${uid}`;
  card.className = "admission-card";
  const photo = data.photoURL
    ? `<img src="${data.photoURL}" class="adm-photo" alt="">`
    : `<div class="adm-photo adm-initials">${escapeHtml(getInitials(data.displayName))}</div>`;
  card.innerHTML = `
    ${photo}
    <div class="adm-info">
      <div class="adm-name">${escapeHtml(data.displayName || "Guest")}</div>
      <div class="adm-sub">wants to join</div>
    </div>
    <div class="adm-actions">
      <button class="btn btn-success btn-sm" onclick="admitGuest('${uid}')">Admit</button>
      <button class="btn btn-danger  btn-sm" onclick="declineGuest('${uid}')">Decline</button>
    </div>`;
  container.appendChild(card);
  container.style.display = "flex";
  showToast(`🔔 ${data.displayName || "Someone"} is waiting to join`);
}

function admitGuest(uid) {
  db.ref(`joinRequests/${meetingId}/${uid}`).update({ status: "admitted" });
  document.getElementById(`req-${uid}`)?.remove();
  _hideQueueIfEmpty();
  showToast("✅ Guest admitted");
}

function declineGuest(uid) {
  db.ref(`joinRequests/${meetingId}/${uid}`).update({ status: "declined" });
  setTimeout(() => db.ref(`joinRequests/${meetingId}/${uid}`).remove(), 3000);
  document.getElementById(`req-${uid}`)?.remove();
  _hideQueueIfEmpty();
}

function _hideQueueIfEmpty() {
  const container = document.getElementById("admissionQueue");
  if (container && container.children.length === 0) container.style.display = "none";
}

// ── Leave / End ────────────────────────────────────────────
async function leaveMeeting() {
  if (!confirm("Leave this meeting?")) return;
  // Stop recording silently if it was running
  if (recorder && recorder.isRecording) await recorder.stop();
  await _cleanup();
  window.location.href = "dashboard.html";
}

async function endMeeting() {
  if (!isHost) return;
  if (!confirm("End this meeting for everyone?")) return;

  // ── Ask about recording download if recording was started ──
  let recordingBlob = null;
  if (recorder && recorder.isRecording) {
    recordingBlob = await stopRecordingAndSave();
  }

  if (recordingBlob) {
    _showDownloadDialog(recordingBlob, async () => {
      await _finishEndMeeting();
    });
    return;
  }

  await _finishEndMeeting();
}

function _showDownloadDialog(blob, afterCallback) {
  // Build modal overlay
  const overlay = document.createElement("div");
  overlay.id = "recDownloadOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:1000;
    background:rgba(0,0,0,0.75);backdrop-filter:blur(8px);
    display:flex;align-items:center;justify-content:center;
  `;
  overlay.innerHTML = `
    <div style="
      background:var(--bg-card);
      border:1px solid var(--border-accent);
      border-radius:var(--radius-lg);
      padding:36px 32px;
      max-width:420px;width:90%;
      text-align:center;
      box-shadow:0 24px 64px rgba(0,0,0,0.6);
    ">
      <div style="font-size:2.5rem;margin-bottom:12px;">🎥</div>
      <h2 style="margin-bottom:8px;font-size:1.2rem;">Save Your Recording?</h2>
      <p style="color:var(--text-secondary);font-size:0.88rem;margin-bottom:28px;line-height:1.55;">
        You recorded this meeting. Would you like to download it as a <strong>.webm</strong> video file before ending?
      </p>
      <div style="display:flex;gap:12px;justify-content:center;">
        <button id="recDownloadYes" class="btn btn-primary" style="min-width:130px;">
          ⬇️ Yes, Download
        </button>
        <button id="recDownloadNo" class="btn btn-ghost" style="min-width:130px;">
          No, End Without
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById("recDownloadYes").onclick = async () => {
    _downloadRecording(blob);
    overlay.remove();
    await afterCallback();
  };
  document.getElementById("recDownloadNo").onclick = async () => {
    overlay.remove();
    await afterCallback();
  };
}

async function _finishEndMeeting() {
  await triggerSummarize();
  if (transcription) await _persistTranscript(transcription.getFullText());
  db.ref(`joinRequests/${meetingId}`).remove();
  await firestore.collection("meetings").doc(meetingId).update({
    status: "ended", endedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  await _cleanup();
  window.location.href = "dashboard.html";
}

async function _cleanup() {
  transcription?.stop();
  aiManager?.destroy();
  if (webrtc) await webrtc.leave();
}

// ── Timer ──────────────────────────────────────────────────
let _meetingStart = Date.now();
function startMeetingTimer() {
  setInterval(() => {
    const el = document.getElementById("meetingTimer");
    if (!el) return;
    const s = Math.floor((Date.now() - _meetingStart) / 1000);
    const h = Math.floor(s / 3600);
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    el.textContent = h > 0 ? `${h}:${m}:${sec}` : `${m}:${sec}`;
  }, 1000);
}

// ── Utilities ──────────────────────────────────────────────
function copyMeetingLink() {
  const url = `${location.origin}${location.pathname.replace("meeting.html","")}lobby.html?id=${meetingId}`;
  navigator.clipboard.writeText(url).then(() => showToast("📋 Invite link copied!"));
}

function showMeetingError(msg) {
  const el = document.getElementById("meetingError");
  if (el) { el.textContent = msg; el.style.display = "block"; }
}

function showToast(msg) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function downloadTranscript() { _downloadText(transcription?.getFullText() || "", `transcript-${meetingId}.txt`); }
function downloadSummary()    { _downloadText(document.getElementById("summaryContent")?.innerText || "", `summary-${meetingId}.txt`); }

function _downloadText(text, filename) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], {type:"text/plain"})), download: filename });
  a.click();
}

function _getTimestamp() { return new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}); }

function escapeHtml(str) {
  return (str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function _markdownToHtml(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/`(.*?)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}
