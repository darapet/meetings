// ============================================================
//  PET-AI.JS — Voice assistant for MeetAI
//  Summoned by saying "Pet AI", shows glowing Tesla-style orb,
//  reads transcript/summary, listens for voice+text, responds
//  via Mistral. Stopped by saying "stop" or clicking ✕.
// ============================================================

class PetAI {
  constructor(meetingId, options = {}) {
    this.meetingId  = meetingId;
    this.options    = options; // { getTranscript, getSummary, isHost, isAudioEnabled }
    this.active     = false;
    this.listening  = false;
    this._permission = "everyone";
    this._wakeRecog  = null;
    this._cmdRecog   = null;
    this._orbEl      = null;
    this._chatEl     = null;
    this._history    = [];
    this._speaking   = false;

    this._createOrbUI();
    this._loadPermission();
  }

  // ── Permission ────────────────────────────────────────────
  async _loadPermission() {
    try {
      const snap = await db.ref("meetings/" + this.meetingId + "/settings/aiSummonPermission").once("value");
      this._permission = snap.val() || "everyone";
    } catch (_) {}
    db.ref("meetings/" + this.meetingId + "/settings/aiSummonPermission").on("value", snap => {
      this._permission = snap.val() || "everyone";
    });
  }

  canSummon() {
    const p = this._permission || "everyone";
    if (p === "everyone") return true;
    if (p === "host")     return this.options.isHost?.() === true;
    if (p === "unmuted")  return this.options.isHost?.() === true || this.options.isAudioEnabled?.() === true;
    return true;
  }

  // ── Wake word detection ───────────────────────────────────
  startWakeWordDetection() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    const startRec = () => {
      if (this.active) return;
      this._wakeRecog = new SR();
      this._wakeRecog.continuous      = true;
      this._wakeRecog.interimResults  = true;
      this._wakeRecog.lang            = navigator.language || "en-US";

      this._wakeRecog.onresult = evt => {
        for (let i = evt.resultIndex; i < evt.results.length; i++) {
          const text = evt.results[i][0].transcript.toLowerCase().trim();
          if ((text.includes("pet ai") || text.includes("petai") || text.includes("pet a.i")) && !this.active) {
            if (this.canSummon()) {
              this._summon();
            } else {
              if (typeof showToast === "function") showToast("Pet AI is restricted by the host");
            }
          }
        }
      };

      this._wakeRecog.onend = () => {
        if (!this.active) setTimeout(startRec, 300);
      };

      this._wakeRecog.onerror = () => {
        if (!this.active) setTimeout(startRec, 1000);
      };

      try { this._wakeRecog.start(); } catch (_) {}
    };

    startRec();
  }

  stopWakeWordDetection() {
    try { this._wakeRecog?.abort(); } catch (_) {}
    this._wakeRecog = null;
  }

  // ── Summon ────────────────────────────────────────────────
  _summon() {
    if (this.active) return;
    this.active = true;
    try { this._wakeRecog?.abort(); } catch (_) {}
    // Broadcast to all participants that Pet AI is active
    try {
      db.ref("petAIBroadcast/" + this.meetingId).set({
        active: true,
        uid: (typeof getCurrentUser === "function" ? getCurrentUser()?.uid : null) || "",
        ts: firebase.database.ServerValue.TIMESTAMP
      });
    } catch (_) {}
    this._clearChat();
    this._showOrb();
    this._greet();
  }

  // ── Orb UI creation ───────────────────────────────────────
  _createOrbUI() {
    const overlay = document.createElement("div");
    overlay.id        = "petAIOverlay";
    overlay.className = "petai-overlay";
    overlay.innerHTML = `
      <div class="petai-panel">
        <button class="petai-close" onclick="if(window.petAI)window.petAI.stop()" title="Stop Pet AI">✕</button>
        <div class="petai-orb-wrap">
          <div class="petai-orb" id="petAIOrb">
            <div class="petai-ring r1"></div>
            <div class="petai-ring r2"></div>
            <div class="petai-ring r3"></div>
            <div class="petai-core">
              <span class="petai-star">✦</span>
            </div>
          </div>
          <div class="petai-status-label" id="petAIStatus">Pet AI</div>
        </div>
        <div class="petai-chat" id="petAIChat"></div>
        <div class="petai-input-row">
          <input class="input petai-text-input" id="petAITextInput" placeholder="Or type a message…"
            onkeydown="if(event.key==='Enter' && window.petAI) window.petAI.sendText()">
          <button class="btn btn-primary btn-sm" onclick="if(window.petAI) window.petAI.sendText()">Send</button>
        </div>
        <div class="petai-quick-btns">
          <button class="btn btn-ghost btn-xs" onclick="if(window.petAI) window.petAI.readSummary()">📖 Summary</button>
          <button class="btn btn-ghost btn-xs" onclick="if(window.petAI) window.petAI.readTranscript()">📝 Transcript</button>
          <button class="btn btn-danger  btn-xs" onclick="if(window.petAI) window.petAI.stop()">✕ Stop</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    this._orbEl  = overlay;
    this._chatEl = overlay.querySelector("#petAIChat");
  }

  _showOrb() { if (this._orbEl) this._orbEl.classList.add("visible"); }
  _hideOrb() { if (this._orbEl) this._orbEl.classList.remove("visible"); }
  _clearChat() { if (this._chatEl) this._chatEl.innerHTML = ""; }

  // ── Greeting ──────────────────────────────────────────────
  async _greet() {
    this._setStatus("Thinking…");
    this._setOrbState("thinking");

    const transcript = this.options.getTranscript?.() || "";
    const ctx = transcript.length > 20
      ? "Meeting has been going on. Recent transcript: " + transcript.slice(-400)
      : "Meeting is just starting or no transcript yet.";

    const greeting = await callMistral([
      { role: "system", content: `You are Pet AI, a friendly meeting assistant for MeetAI. Be concise (1-2 sentences). Context: ${ctx}` },
      { role: "user",   content: "Greet the user briefly and say you're ready to help." }
    ], { max_tokens: 80 });

    this._addMessage("ai", greeting);
    this._speak(greeting, () => {
      if (this.active) { this._setStatus("Listening…"); this._setOrbState("listening"); this._startCmdListening(); }
    });
  }

  // ── Command listening ─────────────────────────────────────
  _startCmdListening() {
    if (!this.active || this._speaking) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    this.listening = true;
    this._setOrbState("listening");

    this._cmdRecog = new SR();
    this._cmdRecog.continuous     = false;
    this._cmdRecog.interimResults = false;
    this._cmdRecog.lang           = navigator.language || "en-US";

    this._cmdRecog.onresult = async evt => {
      const text = evt.results[0][0].transcript.trim();
      const lower = text.toLowerCase();
      if (lower === "stop" || lower === "goodbye" || lower === "dismiss" || lower === "close") {
        this.stop(); return;
      }
      await this._handleInput(text);
    };

    this._cmdRecog.onend = () => {
      this.listening = false;
      if (this.active && !this._speaking) {
        setTimeout(() => {
          if (this.active && !this._speaking) this._startCmdListening();
        }, 400);
      }
    };

    this._cmdRecog.onerror = () => {
      this.listening = false;
      if (this.active && !this._speaking) {
        setTimeout(() => {
          if (this.active && !this._speaking) this._startCmdListening();
        }, 800);
      }
    };

    try { this._cmdRecog.start(); } catch (_) {}
  }

  _stopCmdListening() {
    this.listening = false;
    try { this._cmdRecog?.abort(); } catch (_) {}
    this._cmdRecog = null;
  }

  // ── Handle user input ─────────────────────────────────────
  async _handleInput(text) {
    if (!text || !this.active) return;
    this._addMessage("user", text);
    this._setStatus("Thinking…");
    this._setOrbState("thinking");
    this._stopCmdListening();

    const transcript = this.options.getTranscript?.() || "";
    const summary    = this.options.getSummary?.()    || "";

    const systemPrompt = [
      "You are Pet AI, a concise meeting assistant for MeetAI. Answer in 2-3 sentences max unless detail is explicitly needed.",
      transcript ? `Meeting transcript (recent): ${transcript.slice(-600)}` : "",
      summary    ? `Meeting summary: ${summary}` : ""
    ].filter(Boolean).join("\n");

    this._history.push({ role: "user", content: text });
    const msgs = [
      { role: "system", content: systemPrompt },
      ...this._history.slice(-8)
    ];

    const response = await callMistral(msgs, { max_tokens: 250 });
    this._history.push({ role: "assistant", content: response });

    this._addMessage("ai", response);
    this._speak(response, () => {
      if (this.active) { this._setStatus("Listening…"); this._setOrbState("listening"); this._startCmdListening(); }
    });
  }

  // ── Public actions ────────────────────────────────────────
  async sendText() {
    const inp = document.getElementById("petAITextInput");
    const text = (inp?.value || "").trim();
    if (!text) return;
    if (inp) inp.value = "";
    this._stopCmdListening();
    await this._handleInput(text);
  }

  async readSummary() {
    const summary = this.options.getSummary?.() || "";
    this._stopCmdListening();
    if (!summary) {
      const msg = "No summary available yet. The meeting may be too short.";
      this._addMessage("ai", msg); this._speak(msg); return;
    }
    this._addMessage("ai", "📖 Meeting Summary:\n" + summary);
    this._speak("Here's the meeting summary: " + summary.slice(0, 350), () => {
      if (this.active) { this._setStatus("Listening…"); this._setOrbState("listening"); this._startCmdListening(); }
    });
  }

  async readTranscript() {
    const transcript = this.options.getTranscript?.() || "";
    this._stopCmdListening();
    if (!transcript) {
      const msg = "No transcript captured yet. Make sure microphone is enabled.";
      this._addMessage("ai", msg); this._speak(msg); return;
    }
    const snippet = transcript.slice(-500);
    this._addMessage("ai", "📝 Recent transcript:\n" + snippet);
    this._speak("Here's what was recently said: " + snippet.slice(0, 300), () => {
      if (this.active) { this._setStatus("Listening…"); this._setOrbState("listening"); this._startCmdListening(); }
    });
  }

  // ── Speech ────────────────────────────────────────────────
  _speak(text, onDone) {
    if (!text) { onDone?.(); return; }
    window.speechSynthesis?.cancel();
    this._speaking = true;
    this._setOrbState("speaking");
    // Broadcast spoken text so all participants can hear Pet AI
    try {
      db.ref("petAIBroadcast/" + this.meetingId + "/speech").set({
        text: text.replace(/[✦📖📝]/g, "").trim(),
        ts: Date.now()
      });
    } catch (_) {}

    const utter = new SpeechSynthesisUtterance(text.replace(/[✦📖📝]/g, ""));
    utter.rate   = 1.05;
    utter.pitch  = 1.0;
    utter.volume = 1.0;

    const trySetVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      const voice  = voices.find(v => v.lang.startsWith("en") && v.name.toLowerCase().includes("natural"))
                  || voices.find(v => v.lang.startsWith("en") && !v.name.includes("Zira"))
                  || voices.find(v => v.lang.startsWith("en"));
      if (voice) utter.voice = voice;
    };

    if (window.speechSynthesis.getVoices().length) trySetVoice();
    else window.speechSynthesis.onvoiceschanged = trySetVoice;

    utter.onend   = () => { this._speaking = false; onDone?.(); };
    utter.onerror = () => { this._speaking = false; onDone?.(); };
    window.speechSynthesis.speak(utter);
  }

  // ── Stop ──────────────────────────────────────────────────
  stop() {
    this.active    = false;
    this.listening = false;
    this._speaking = false;
    this._history  = [];
    window.speechSynthesis?.cancel();
    this._stopCmdListening();
    this._hideOrb();
    this._setStatus("Pet AI");
    this._setOrbState("idle");
    // Clear broadcast so all participants restore their mics
    try { db.ref("petAIBroadcast/" + this.meetingId).set({ active: false }); } catch (_) {}
    setTimeout(() => this.startWakeWordDetection(), 800);
  }

  // ── Orb state ──────────────────────────────────────────────
  _setOrbState(state) {
    const orb = document.getElementById("petAIOrb");
    if (!orb) return;
    orb.dataset.state = state;
  }

  _setStatus(text) {
    const el = document.getElementById("petAIStatus");
    if (el) el.textContent = text;
  }

  // ── Chat messages ─────────────────────────────────────────
  _addMessage(role, text) {
    if (!this._chatEl) return;
    const div = document.createElement("div");
    div.className = "petai-msg petai-msg-" + role;
    div.textContent = text;
    this._chatEl.appendChild(div);
    this._chatEl.scrollTop = this._chatEl.scrollHeight;
  }

  // ── Cleanup ───────────────────────────────────────────────
  destroy() {
    this.active = false;
    window.speechSynthesis?.cancel();
    this._stopCmdListening();
    this.stopWakeWordDetection();
    this._hideOrb();
    db.ref("meetings/" + this.meetingId + "/settings/aiSummonPermission").off();
  }
}
