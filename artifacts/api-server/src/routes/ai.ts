import { Router } from "express";
import { Mistral } from "@mistralai/mistralai";
import { AiChatBody, AiSummarizeBody } from "@workspace/api-zod";

const router = Router();

function getMistral() {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error("MISTRAL_API_KEY not set");
  return new Mistral({ apiKey });
}

router.post("/ai/chat", async (req, res) => {
  const parsed = AiChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { message, conversationHistory = [] } = parsed.data;

  try {
    const client = getMistral();

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      {
        role: "system",
        content:
          "You are PET AI, an intelligent and friendly meeting assistant. " +
          "You help participants by answering questions, summarizing discussions, " +
          "providing insights, and keeping meetings productive. " +
          "Be concise but thorough. Everyone in the meeting can hear you.",
      },
      ...(conversationHistory as { role: "system" | "user" | "assistant"; content: string }[]),
      { role: "user", content: message },
    ];

    const result = await client.chat.complete({
      model: "mistral-large-latest",
      messages,
    });

    const reply = result.choices?.[0]?.message?.content ?? "I couldn't generate a response.";
    res.json({ reply: typeof reply === "string" ? reply : JSON.stringify(reply) });
  } catch (err) {
    req.log?.error({ err }, "AI chat error");
    res.status(500).json({ error: "AI service unavailable" });
  }
});

router.post("/ai/summarize", async (req, res) => {
  const parsed = AiSummarizeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { transcript, bookMode } = parsed.data;

  try {
    const client = getMistral();

    const prompt = bookMode
      ? `You are a professional meeting scribe. Compile the following meeting transcript into a structured, comprehensive book-like format with these chapters:\n\n1. Introduction\n2. Core Discussions\n3. Conclusions\n4. Action Items\n\nBe thorough and professional.\n\nTranscript:\n${transcript}`
      : `Summarize the following meeting transcript concisely and clearly. Highlight key points, decisions made, and any action items:\n\nTranscript:\n${transcript}`;

    const result = await client.chat.complete({
      model: "mistral-large-latest",
      messages: [{ role: "user", content: prompt }],
    });

    const summary = result.choices?.[0]?.message?.content ?? "Could not generate summary.";
    res.json({ summary: typeof summary === "string" ? summary : JSON.stringify(summary) });
  } catch (err) {
    req.log?.error({ err }, "AI summarize error");
    res.status(500).json({ error: "AI service unavailable" });
  }
});

export default router;
