import { Router } from "express";
import { AccessToken } from "livekit-server-sdk";
import { GetLivekitTokenBody } from "@workspace/api-zod";

const router = Router();

router.post("/livekit/token", async (req, res) => {
  const parsed = GetLivekitTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { roomName, participantName, isHost } = parsed.data;

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.VITE_LIVEKIT_WS_URL;

  if (!apiKey || !apiSecret || !wsUrl) {
    res.status(500).json({ error: "LiveKit is not configured" });
    return;
  }

  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantName,
    ttl: "4h",
  });

  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    roomAdmin: isHost ?? false,
  });

  const jwt = await token.toJwt();

  res.json({ token: jwt, wsUrl });
});

export default router;
