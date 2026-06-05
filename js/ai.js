// ============================================================
//  AI.JS — Mistral AI: Summarizer, Book Mode, AI Chat Terminal
// ============================================================

class AIManager {
  constructor(meetingId, userId) {
    this.meetingId      = meetingId;
    this.userId         = userId;
    this.bookMode       = false;
    this.summaryHistory = [];
    this.aiChatHistory  = [];
    this.ttsUtterance   = null;
    this.ttsPlaying     = false;
    this.vadHandle      = null;
    this._lastResponse  = "";
  }

  // ── Summarize transcript via Mistral ───────────────────────
  async summarize(transcript, mode = "standard") {
    if (MISTRAL_API_KEYS.length === 0) {
      return "⚠️ No Mistral API key configured. Open js/config.js and add your key(s) to MISTRAL_API_KEYS.";
    }
    if (!transcript || transcript.trim().length < 30) {
      return "Not enough transcript content to summarize yet. Keep talking!";
    }

    const systemPrompt = mode === "book"
      ? `You are an expert meeting analyst and professional writer. Compile the following meeting transcript into a structured, comprehensive document with clearly defined chapters. Use this format:

# Meeting Summary

## 1. Introduction
(Context, date/time if available, and who participated)

## 2. Core Discussions
(Key topics debated, arguments made, perspectives shared)

## 3. Decisions Made
(Concrete decisions and agreements reached)

## 4. Conclusions
(Overall outcomes and what was resolved)

## 5. Action Items
(Specific tasks, with owner names if mentioned, and deadlines)

## 6. Open Questions
(Unresolved items that need follow-up)

Be thorough, professional, and write in clear English. Use bullet points under each chapter.`
      : `You are a concise meeting summarizer. From this meeting transcript, produce:
- 3-5 bullet points of the key discussion topics
- Any decisions made
- Any action items with owners if mentioned
Keep it brief, clear, and actionable. No fluff.`;

    const reply = await callMistral([
      { role: "system", content: systemPrompt },
      { role: "user",   content: `Meeting Transcript:\n\n${transcript}` }
    ], { temperature: 0.4, max_tokens: mode === "book" ? 2000 : 600 });

    this.summaryHistory.push({ timestamp: new Date().toISOString(), mode, summary: reply });
    return reply;
  }

  // ── AI Chat via Mistral ────────────────────────────────────
  async chat(userMessage, transcript = "") {
    if (MISTRAL_API_KEYS.length === 0) {
      return "⚠️ No Mistral API key configured. Open js/config.js and add your key(s).";
    }

    // Detect "Continue" command
    if (/^(continue|resume|keep going|go on)\.?$/i.test(userMessage.trim())) {
      if (this._lastResponse) {
        return this._lastResponse;
      }
      return "Nothing to continue — ask me something first!";
    }

    this.aiChatHistory.push({ role: "user", content: userMessage });

    const systemPrompt = `You are MeetAI, an intelligent AI meeting assistant powered by Mistral AI. You are embedded in a live video conference.
You can:
- Answer questions about what was discussed (using the live transcript below)
- Help summarize key points
- Suggest action items or next steps
- Brainstorm ideas raised in the meeting
- Have helpful conversation

If the user says "Continue" or "Resume", pick up your last response naturally.
Be concise, clear, and professional. Respond in the same language the user uses.
Active Mistral keys loaded: ${MISTRAL_API_KEYS.length}
${transcript ? `\n\n--- LIVE MEETING TRANSCRIPT ---\n${transcript.slice(-3000)}\n--- END TRANSCRIPT ---` : ""}`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...this.aiChatHistory.slice(-14)
    ];

    const reply = await callMistral(messages, { temperature: 0.6, max_tokens: 800 });
    this._lastResponse = reply;
    this.aiChatHistory.push({ role: "assistant", content: reply });
    return reply;
  }

  // ── Text-to-Speech (browser built-in) ─────────────────────
  speak(text, onEnd) {
    if (!("speechSynthesis" in window)) return;
    this.stopSpeaking();
    const clean = text.replace(/[#*`_~]/g, "").trim();
    this.ttsUtterance = new SpeechSynthesisUtterance(clean);
    this.ttsUtterance.rate   = 1.05;
    this.ttsUtterance.pitch  = 1.0;
    this.ttsUtterance.volume = 1.0;
    // Pick a natural voice if available
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v => v.lang.startsWith("en") && v.localService);
    if (preferred) this.ttsUtterance.voice = preferred;

    this.ttsUtterance.onend   = () => { this.ttsPlaying = false; if (onEnd) onEnd(); };
    this.ttsUtterance.onerror = () => { this.ttsPlaying = false; };
    window.speechSynthesis.speak(this.ttsUtterance);
    this.ttsPlaying = true;
  }

  stopSpeaking() {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    this.ttsPlaying = false;
  }

  pauseSpeaking() {
    if ("speechSynthesis" in window) window.speechSynthesis.pause();
  }

  resumeSpeaking() {
    if ("speechSynthesis" in window) window.speechSynthesis.resume();
  }

  isSpeaking() {
    return "speechSynthesis" in window && window.speechSynthesis.speaking;
  }

  // ── Auto-interrupt TTS when human speaks (VAD) ────────────
  async attachVADInterrupt(stream, onInterrupted, onResumeReady) {
    if (this.vadHandle) { try { this.vadHandle.stop(); } catch (_) {} }
    try {
      this.vadHandle = await LiveTranscription.createVAD(
        stream,
        () => {
          if (this.isSpeaking()) {
            this.pauseSpeaking();
            if (onInterrupted) onInterrupted();
          }
        },
        () => { if (onResumeReady) onResumeReady(); }
      );
    } catch (_) {}
  }

  // ── Save summary to Firestore ──────────────────────────────
  async saveSummaryToFirestore(summary, mode) {
    try {
      await firestore.collection("meetings").doc(this.meetingId)
        .collection("summaries").add({
          summary,
          mode,
          userId:    this.userId,
          model:     MISTRAL_MODEL,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch (_) {}
  }

  // ── Cleanup ────────────────────────────────────────────────
  destroy() {
    this.stopSpeaking();
    if (this.vadHandle) { try { this.vadHandle.stop(); } catch (_) {} }
  }
}
