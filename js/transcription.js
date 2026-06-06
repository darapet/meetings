// ============================================================
//  TRANSCRIPTION.JS — Web Speech API live transcription
//  v2: instant restart (no 500ms gap), faster perceived speed
// ============================================================

class LiveTranscription {
  constructor(onTranscript, onError, onStatus) {
    this.onTranscript  = onTranscript;
    this.onError       = onError;
    this.onStatus      = onStatus;
    this.recognition   = null;
    this.running       = false;
    this.paused        = false;
    this.fullText      = "";
    this.lastFinal     = "";
    this._restartTimer = null;
    this._supported    = ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
  }

  isSupported() { return this._supported; }

  start() {
    if (!this._supported) {
      this.onError("Speech recognition not supported. Use Chrome or Edge.");
      return;
    }
    if (this.running) return;
    this._initRecognition();
    this.running = true;
    this.paused  = false;
    try { this.recognition.start(); } catch (_) {}
    this.onStatus("listening");
  }

  _initRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SR();

    // Core settings for speed + accuracy
    this.recognition.continuous      = true;
    this.recognition.interimResults  = true;   // show words as they're spoken
    this.recognition.maxAlternatives = 1;
    this.recognition.lang            = navigator.language || "en-US";

    this.recognition.onresult = evt => {
      let interim = "";
      for (let i = evt.resultIndex; i < evt.results.length; i++) {
        const res = evt.results[i];
        if (res.isFinal) {
          const text = res[0].transcript.trim();
          if (text && text !== this.lastFinal) {
            this.lastFinal = text;
            this.fullText += (this.fullText ? " " : "") + text;
            this.onTranscript({ type: "final", text, fullText: this.fullText.trim() });
          }
        } else {
          interim += res[0].transcript;
        }
      }
      // Interim fires on every recognized phoneme — real-time feedback
      if (interim) {
        this.onTranscript({ type: "interim", text: interim, fullText: this.fullText.trim() });
      }
    };

    this.recognition.onerror = evt => {
      if (["not-allowed", "service-not-allowed", "audio-capture"].includes(evt.error)) {
        this.running = false;
        this.onStatus("error");
        this.onError(`Mic error: ${evt.error}. Please allow microphone access.`);
      } else if (evt.error === "no-speech") {
        // no-speech is normal — will auto-restart below, don't show error
      } else if (evt.error === "aborted") {
        // aborted is expected during restart cycle — ignore
      } else {
        // network / other — restart quickly
        this._scheduleRestart(300);
      }
    };

    this.recognition.onend = () => {
      if (this.running && !this.paused) {
        // Restart IMMEDIATELY — was 500ms before, causing perceived "gaps"
        // Use 50ms to avoid browser racing condition on rapid restart
        this._scheduleRestart(50);
      } else {
        this.onStatus("stopped");
      }
    };

    this.recognition.onsoundstart = () => this.onStatus("listening");
    this.recognition.onsoundend   = () => this.onStatus("silence");
  }

  _scheduleRestart(delay = 50) {
    clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => {
      if (!this.running || this.paused) return;
      try {
        this.recognition.start();
        this.onStatus("listening");
      } catch (e) {
        // If already started, wait a bit more
        if (e.name === "InvalidStateError") this._scheduleRestart(200);
      }
    }, delay);
  }

  pause() {
    this.paused = true;
    clearTimeout(this._restartTimer);
    try { this.recognition.stop(); } catch (_) {}
    this.onStatus("paused");
  }

  resume() {
    if (!this.running) { this.start(); return; }
    this.paused = false;
    try { this.recognition.start(); } catch (_) {}
    this.onStatus("listening");
  }

  stop() {
    this.running = false;
    this.paused  = false;
    clearTimeout(this._restartTimer);
    try { this.recognition.stop(); } catch (_) {}
    this.onStatus("stopped");
  }

  getFullText()  { return this.fullText.trim(); }
  clearText()    { this.fullText = ""; this.lastFinal = ""; }

  // Voice activity detection via AudioContext
  static async createVAD(stream, onSpeaking, onSilence) {
    const ctx  = new AudioContext();
    const src  = ctx.createMediaStreamSource(stream);
    const anal = ctx.createAnalyser();
    anal.fftSize = 512;
    src.connect(anal);
    const data = new Uint8Array(anal.frequencyBinCount);
    let speaking = false;
    let silTimer = null;
    const tick = () => {
      anal.getByteFrequencyData(data);
      const avg = data.reduce((s, v) => s + v, 0) / data.length;
      if (avg > 15) {
        if (!speaking) { speaking = true; onSpeaking(); }
        clearTimeout(silTimer);
        silTimer = setTimeout(() => { speaking = false; onSilence(); }, 1200);
      }
      requestAnimationFrame(tick);
    };
    tick();
    return { stop: () => ctx.close() };
  }
}
