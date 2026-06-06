// ============================================================
//  AUDIO-PROCESSOR.JS — Professional voice pipeline v2
//  Fixes: mic-off still processing, latency, same-room echo
//  Chain: source → muteGain → HPF → presence → LPF →
//         compressor → gate → dest
// ============================================================

class AudioProcessor {
  constructor() {
    this.ctx            = null;
    this.muteGain       = null;   // ← silences chain when mic is off
    this.gateNode       = null;
    this.processedStream = null;

    // Noise gate state
    this._gateOpen      = false;
    this._holdLeft      = 0;
    this._gainTarget    = 0;
    this._gainCurrent   = 0;

    // ── Tunable parameters (can change at runtime) ────────
    this.GATE_THRESHOLD_DB = -36; // open threshold (higher = stricter)
    this.GATE_CLOSE_DB     = -44; // close threshold (hysteresis)

    // Coefficients set after ctx is ready
    this.ATTACK_COEFF   = 0;
    this.RELEASE_COEFF  = 0;
    this.HOLD_SAMPLES   = 0;
    this.BLOCK_SIZE     = 128;    // 128 @ 48kHz = 2.7ms per block (low latency)
  }

  // ── Process a raw getUserMedia stream ─────────────────────
  async process(rawStream) {
    if (!rawStream) return rawStream;

    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    if (this.ctx.state === "suspended") {
      try { await this.ctx.resume(); } catch (_) {}
    }

    const sr = this.ctx.sampleRate;
    // Faster coefficients — snappier gate
    this.ATTACK_COEFF  = Math.exp(-1 / (0.001 * sr / this.BLOCK_SIZE));  // 1 ms attack
    this.RELEASE_COEFF = Math.exp(-1 / (0.100 * sr / this.BLOCK_SIZE));  // 100 ms release
    this.HOLD_SAMPLES  = Math.round(0.20 * sr / this.BLOCK_SIZE);        // 200 ms hold

    const source = this.ctx.createMediaStreamSource(rawStream);

    // ── 0. Mute gate — FIRST node; set gain=0 to silence everything ─
    // This is what fixes "noise still active when mic is off"
    this.muteGain = this.ctx.createGain();
    this.muteGain.gain.value = 1;

    // ── 1. High-pass at 100 Hz ────────────────────────────────
    const hpf = this.ctx.createBiquadFilter();
    hpf.type            = "highpass";
    hpf.frequency.value = 100;
    hpf.Q.value         = 0.7;

    // ── 2. Voice presence boost (+3 dB at 2.4 kHz) ────────────
    const presence = this.ctx.createBiquadFilter();
    presence.type            = "peaking";
    presence.frequency.value = 2400;
    presence.gain.value      = 3;
    presence.Q.value         = 0.9;

    // ── 3. Low-pass at 7.5 kHz ────────────────────────────────
    const lpf = this.ctx.createBiquadFilter();
    lpf.type            = "lowpass";
    lpf.frequency.value = 7500;
    lpf.Q.value         = 0.7;

    // ── 4. Compressor — tighten dynamic range ─────────────────
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -26;
    comp.knee.value      = 8;
    comp.ratio.value     = 4;
    comp.attack.value    = 0.001;  // 1 ms — fast attack prevents transient clipping
    comp.release.value   = 0.150;

    // ── 5. Noise gate (ScriptProcessor) ───────────────────────
    const gate   = this.ctx.createScriptProcessor(this.BLOCK_SIZE, 1, 1);
    this.gateNode = gate;
    const self   = this;

    gate.onaudioprocess = function(ev) {
      const inp = ev.inputBuffer.getChannelData(0);
      const out = ev.outputBuffer.getChannelData(0);

      // RMS over block
      let sum = 0;
      for (let i = 0; i < inp.length; i++) sum += inp[i] * inp[i];
      const rms = Math.sqrt(sum / inp.length);
      const db  = rms > 1e-9 ? 20 * Math.log10(rms) : -120;

      // Gate logic: hysteresis + hold prevents chattering
      if (db > self.GATE_THRESHOLD_DB) {
        self._gateOpen  = true;
        self._holdLeft  = self.HOLD_SAMPLES;
        self._gainTarget = 1;
      } else if (self._gateOpen) {
        if (self._holdLeft > 0) {
          self._holdLeft--;
        } else if (db < self.GATE_CLOSE_DB) {
          self._gateOpen   = false;
          self._gainTarget  = 0;
        }
      }

      // Smooth gain — avoids clicks/pops on gate transitions
      for (let i = 0; i < inp.length; i++) {
        const coeff = self._gainTarget > self._gainCurrent
          ? (1 - self.ATTACK_COEFF)
          : (1 - self.RELEASE_COEFF);
        self._gainCurrent += coeff * (self._gainTarget - self._gainCurrent);
        out[i] = inp[i] * self._gainCurrent;
      }
    };

    // ── 6. Output gain = 1.0 ──────────────────────────────────
    // Intentionally NOT amplifying — keeps signal natural to avoid
    // echo feedback when two devices are in the same room
    const outputGain = this.ctx.createGain();
    outputGain.gain.value = 1.0;

    // ── Connect chain ──────────────────────────────────────────
    const dest = this.ctx.createMediaStreamDestination();
    source
      .connect(this.muteGain)
      .connect(hpf)
      .connect(presence)
      .connect(lpf)
      .connect(comp)
      .connect(gate)
      .connect(outputGain)
      .connect(dest);

    // Build output stream (processed audio + original video tracks)
    this.processedStream = new MediaStream([
      ...dest.stream.getAudioTracks(),
      ...rawStream.getVideoTracks()
    ]);

    return this.processedStream;
  }

  // ── Called by WebRTCManager when user mutes/unmutes mic ────
  // This is the real fix for "noise still active when mic is off"
  setInputEnabled(enabled) {
    if (!this.muteGain || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.muteGain.gain.cancelScheduledValues(t);
    // Smooth 5ms ramp prevents click artifact on mute
    this.muteGain.gain.linearRampToValueAtTime(enabled ? 1 : 0, t + 0.005);
    // Also force gate closed when muting so status indicators update
    if (!enabled) {
      this._gateOpen   = false;
      this._gainTarget  = 0;
      this._gainCurrent = 0;
    }
  }

  // ── Adjust gate sensitivity at runtime (called by slider) ──
  setThreshold(db) {
    this.GATE_THRESHOLD_DB = db;
    this.GATE_CLOSE_DB     = db - 8;
  }

  // ── For the mic-level bar UI ───────────────────────────────
  getGateState() {
    return { open: this._gateOpen, gain: this._gainCurrent };
  }

  destroy() {
    this.gateNode  = null;
    this.muteGain  = null;
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
  }
}
