import { Router } from "express";
import { CreateMeetingBody } from "@workspace/api-zod";
import { randomUUID } from "crypto";

const router = Router();

// In-memory store — Firebase Firestore is the real source of truth on the client
const meetings = new Map<string, {
  id: string;
  roomName: string;
  title: string;
  hostName: string;
  createdAt: string;
  participantCount: number;
  isActive: boolean;
  maxParticipants: number;
}>();

const MAX_MEETINGS = 5;

router.get("/meetings", (_req, res) => {
  const active = Array.from(meetings.values()).filter((m) => m.isActive);
  res.json(active);
});

router.get("/meetings/stats", (_req, res) => {
  const active = Array.from(meetings.values()).filter((m) => m.isActive);
  const totalParticipants = active.reduce((sum, m) => sum + m.participantCount, 0);
  res.json({
    activeMeetings: active.length,
    totalParticipants,
    maxMeetingsAllowed: MAX_MEETINGS,
    meetingsList: active,
  });
});

router.post("/meetings", (req, res) => {
  const parsed = CreateMeetingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const active = Array.from(meetings.values()).filter((m) => m.isActive);
  if (active.length >= MAX_MEETINGS) {
    res.status(429).json({ error: `Maximum of ${MAX_MEETINGS} concurrent meetings reached` });
    return;
  }

  const id = randomUUID();
  const roomName = `room-${id.slice(0, 8)}`;
  const meeting = {
    id,
    roomName,
    title: parsed.data.title,
    hostName: parsed.data.hostName,
    createdAt: new Date().toISOString(),
    participantCount: 0,
    isActive: true,
    maxParticipants: parsed.data.maxParticipants ?? 1000,
  };

  meetings.set(id, meeting);
  res.status(201).json(meeting);
});

router.get("/meetings/:roomId", (req, res) => {
  const meeting = meetings.get(req.params.roomId);
  if (!meeting) {
    res.status(404).json({ error: "Meeting not found" });
    return;
  }
  res.json(meeting);
});

router.delete("/meetings/:roomId", (req, res) => {
  const meeting = meetings.get(req.params.roomId);
  if (meeting) {
    meeting.isActive = false;
  }
  res.status(204).send();
});

export default router;
