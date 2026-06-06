// ============================================================
//  AUDIO-PROCESSOR.JS — Professional voice processing chain
//  Pipeline:  mic → HP filter → LP filter → compressor →
//             noise gate → gain → processed stream
// ============================================================

class AudioProcessor {
  constructor() {
    this.ctx          = null;
    this.gateNode     = null;
    this.processedStream = null;
    this._animId      = null;

    // Noise gate state
    this._gateOpen    = false;
    this._holdLeft    = 0;        // samples remaining in hold phase
    this._gainTarget  = 0;        // 0 = closed, 1 = open
    this._gainCurrent = 0;        // smoothed gain value

    // ── Tunable parameters ────────────────────────────────
    // Raise GATE_THRESHOLD_DB to reject more distant/quiet sounds.
    // -34 rejects distant voices, audience noise, TV in background.
    this.GATE_THRESHOLD_DB = -36; // dBFS open threshold
    this.GATE_CLOSE_DB     = -44; // dBFS close threshold (hysteresis)
    this.ATTACK_COEFF      = 0;   // computed after ctx is ready
    this.RELEASE_COEFF     = 0;
    this.HOLD_SAMPLES      = 0;
    this.BLOCK_SIZE        = 256; // ScriptProcessor block size
  }

  // ── Process a raw getUserMedia stream ─────────────────────
  async process(rawStream) {
    if (!rawStream) return rawStream;

    // Resume on Safari
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    if (this.ctx.state === "suspended") {
      try { await this.ctx.resume(); } catch (_) {}
    }

    const sr = this.ctx.sampleRate;
    // Gate timing coefficients
    this.ATTACK_COEFF  = Math.exp(-1 / (0.005 * sr / this.BLOCK_SIZE));  // 5 ms attack
    this.RELEASE_COEFF = Math.exp(-1 / (0.150 * sr / this.BLOCK_SIZE));  // 150 ms release
    this.HOLD_SAMPLES  = Math.round(0.30 * sr / this.BLOCK_SIZE);        // 300 ms hold

    const source = this.ctx.createMediaStreamSource(rawStream);

    // ── 1. High-pass filter — remove everything below 100 Hz ─
    // Cuts: room rumble, HVAC, traffic, low-frequency handling noise
    const hpf = this.ctx.createBiquadFilter();
    hpf.type            = "highpass";
    hpf.frequency.value = 100;
    hpf.Q.value         = 0.7;

    // ── 2. Voice-presence boost — 2-3 kHz shelf ───────────────
    // Adds clarity and crispness to speech, helps intelligibility
    const presence = this.ctx.createBiquadFilter();
    presence.type            = "peaking";
    presence.frequency.value = 2400;
    presence.gain.value      = 3.5;   // +3.5 dB presence
    presence.Q.value         = 0.9;

    // ── 3. Low-pass filter — remove everything above 7.5 kHz ──
    // Cuts: hiss, fan noise, electrical interference above voice range
    const lpf = this.ctx.createBiquadFilter();
    lpf.type            = "lowpass";
    lpf.frequency.value = 7500;
    lpf.Q.value         = 0.7;

    // ── 4. Dynamics compressor ─────────────────────────────────
    // Makes voice level consistent; attenuates sudden loud sounds
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -26;   // start compressing at -26 dBFS
    comp.knee.value      = 10;    // gentle knee
    comp.ratio.value     = 4;     // 4:1 — gentle but effective
    comp.attack.value    = 0.002; // 2 ms fast attack
    comp.release.value   = 0.200; // 200 ms release

    // ── 5. Noise gate (ScriptProcessor) ───────────────────────
    // Core fix: silences anything below speaking level
    // This is what kills distant voices, background chatter, room noise
    const bufSize = this.BLOCK_SIZE;
    /* eslint-disable-next-line no-deprecated-doo-not-use */
    const gate = this.ctx.createScriptProcessor(bufSize, 1, 1);
    this.gateNode = gate;
    const self = this;

    gate.onaudioprocess = function(ev) {
      const inp = ev.inputBuffer.getChannelData(0);
      const out = ev.outputBuffer.getChannelData(0);

      // RMS over block
      let sum = 0;
      for (let i = 0; i < inp.length; i++) sum += inp[i] * inp[i];
      const rms = Math.sqrt(sum / inp.length);
      const db  = rms > 1e-9 ? 20 * Math.log10(rms) : -120;

      // Gate logic with hysteresis + hold
      if (db > self.GATE_THRESHOLD_DB) {
        self._gateOpen  = true;
        self._holdLeft  = self.HOLD_SAMPLES;
        self._gainTarget = 1;
      } else if (self._gateOpen) {
        if (self._holdLeft > 0) {
          self._holdLeft--;
          // still in hold — keep gate open
        } else if (db < self.GATE_CLOSE_DB) {
          self._gateOpen  = false;
          self._gainTarget = 0;
        }
      }

      // Smooth gain transition (prevents clicks/pops)
      for (let i = 0; i < inp.length; i++) {
        const coeff = self._gainTarget > self._gainCurrent
          ? (1 - self.ATTACK_COEFF)
          : (1 - self.RELEASE_COEFF);
        self._gainCurrent += coeff * (self._gainTarget - self._gainCurrent);
        out[i] = inp[i] * self._gainCurrent;
      }
    };

    // ── 6. Make-up gain — restore level after gating ──────────
    const makeupGain = this.ctx.createGain();
    makeupGain.gain.value = 1.3;

    // ── Connect the chain ──────────────────────────────────────
    const dest = this.ctx.createMediaStreamDestination();
    source
      .connect(hpf)
      .connect(presence)
      .connect(lpf)
      .connect(comp)
      .connect(gate)
      .connect(makeupGain)
      .connect(dest);

    // ── Build output stream (processed audio + original video) ─
    const audioTracks = dest.stream.getAudioTracks();
    const videoTracks = rawStream.getVideoTracks();
    this.processedStream = new MediaStream([...audioTracks, ...videoTracks]);

    return this.processedStream;
  }

  // ── Expose live gate state for UI (mic level meter) ────────
  getGateState() {
    return { open: this._gateOpen, gain: this._gainCurrent };
  }

  // ── Adjust sensitivity at runtime ──────────────────────────
  setThreshold(db) {
    this.GATE_THRESHOLD_DB = db;
    this.GATE_CLOSE_DB     = db - 8;
  }

  destroy() {
    this.gateNode = null;
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
  }
}
