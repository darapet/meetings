// ============================================================
//  TRANSCRIPTION.JS — Web Speech API live transcription
// ============================================================

class LiveTranscription {
  constructor(onTranscript, onError, onStatus) {
    this.onTranscript = onTranscript;
    this.onError      = onError;
    this.onStatus     = onStatus;
    this.recognition  = null;
    this.running      = false;
    this.paused       = false;
    this.fullText     = "";
    this.lastFinal    = "";
    this._restartTimer = null;
    this._supported   = ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
  }

  isSupported() {
    return this._supported;
  }

  start() {
    if (!this._supported) {
      this.onError("Speech recognition is not supported in this browser. Use Chrome or Edge.");
      return;
    }
    if (this.running) return;
    this._initRecognition();
    this.running = true;
    this.paused  = false;
    this.recognition.start();
    this.onStatus("listening");
  }

  _initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();
    this.recognition.continuous      = true;
    this.recognition.interimResults  = true;
    this.recognition.maxAlternatives = 1;
    this.recognition.lang            = "en-US";

    this.recognition.onresult = evt => {
      let interim = "";
      for (let i = evt.resultIndex; i < evt.results.length; i++) {
        const res = evt.results[i];
        if (res.isFinal) {
          const text = res[0].transcript.trim();
          if (text) {
            this.lastFinal = text;
            this.fullText += " " + text;
            this.onTranscript({ type: "final", text, fullText: this.fullText.trim() });
          }
        } else {
          interim += res[0].transcript;
        }
      }
      if (interim) {
        this.onTranscript({ type: "interim", text: interim, fullText: this.fullText.trim() });
      }
    };

    this.recognition.onerror = evt => {
      const badErrors = ["not-allowed", "service-not-allowed", "audio-capture"];
      if (badErrors.includes(evt.error)) {
        this.running = false;
        this.onStatus("error");
        this.onError(`Microphone error: ${evt.error}. Please allow microphone access.`);
      } else if (evt.error === "no-speech") {
        // Ignore — will restart automatically
      } else if (evt.error === "network") {
        this.onTranscript({ type: "error", text: " [cannot transcribe due to poor grammar or conversation]" });
        this._scheduleRestart();
      } else {
        this.onTranscript({ type: "error", text: " [cannot transcribe due to poor grammar or conversation]" });
        this._scheduleRestart();
      }
    };

    this.recognition.onend = () => {
      if (this.running && !this.paused) {
        // Auto-restart to keep continuous transcription
        this._scheduleRestart();
      } else {
        this.onStatus("stopped");
      }
    };

    this.recognition.onsoundstart = () => this.onStatus("listening");
    this.recognition.onsoundend   = () => this.onStatus("silence");
  }

  _scheduleRestart(delay = 500) {
    clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => {
      if (this.running && !this.paused) {
        try {
          this.recognition.start();
          this.onStatus("listening");
        } catch (_) {}
      }
    }, delay);
  }

  pause() {
    this.paused = true;
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

  getFullText() {
    return this.fullText.trim();
  }

  clearText() {
    this.fullText  = "";
    this.lastFinal = "";
  }

  // Detect if someone is speaking (voice activity detection via AudioContext)
  static async createVAD(stream, onSpeaking, onSilence) {
    const ctx     = new AudioContext();
    const src     = ctx.createMediaStreamSource(stream);
    const anal    = ctx.createAnalyser();
    anal.fftSize  = 512;
    src.connect(anal);
    const data    = new Uint8Array(anal.frequencyBinCount);
    let speaking  = false;
    let silTimer  = null;

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
