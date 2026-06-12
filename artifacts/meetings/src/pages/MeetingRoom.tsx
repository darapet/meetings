import { useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/firebase";
import { doc, onSnapshot, updateDoc, increment } from "firebase/firestore";
import { toast } from "sonner";
import {
  Loader2, Users, Copy, WifiOff,
  MessageCircle, Hand, ShieldCheck, PhoneOff,
} from "lucide-react";

import {
  LiveKitRoom,
  GridLayout,
  ParticipantTile,
  useTracks,
  useLocalParticipant,
  useRoomContext,
  RoomAudioRenderer,
  useConnectionState,
  ControlBar,
} from "@livekit/components-react";
import { Track, ConnectionState } from "livekit-client";

import NoteTaker from "@/components/NoteTaker";
import PetAI from "@/components/PetAI";
import ChatPanel from "@/components/ChatPanel";
import HostControlsPanel from "@/components/HostControlsPanel";
import Summarizer from "@/components/Summarizer";

/* ------------------------------------------------------------------ */
/* Inner component — must live inside <LiveKitRoom>                    */
/* ------------------------------------------------------------------ */
function RoomInner({
  meetingId,
  roomName,
  title,
  isHost,
}: {
  meetingId: string;
  roomName: string;
  title: string;
  isHost: boolean;
}) {
  const [, setLocation] = useLocation();
  const room = useRoomContext();
  const connectionState = useConnectionState();
  const isConnected = connectionState === ConnectionState.Connected;

  // Use a ref so Firestore listeners can access localParticipant
  // without being added to useEffect deps (which caused infinite re-renders)
  const { localParticipant } = useLocalParticipant();
  const lpRef = useRef(localParticipant);
  useEffect(() => { lpRef.current = localParticipant; }, [localParticipant]);

  // UI-only state (no media state — LiveKit's ControlBar owns that)
  const [chatOpen, setChatOpen] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [hostControlsOpen, setHostControlsOpen] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [aiToolsHidden, setAiToolsHidden] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const recognitionRef = useRef<{ stop: () => void; start: () => void } | null>(null);

  // Video grid tracks
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  // Participant count
  useEffect(() => {
    const ref = doc(db, "meetings", meetingId);
    updateDoc(ref, { participantCount: increment(1) }).catch(() => {});
    return () => { updateDoc(ref, { participantCount: increment(-1) }).catch(() => {}); };
  }, [meetingId]);

  // ✅ Firestore listener — stable deps only (no localParticipant, no isConnected)
  //    Use lpRef.current to access localParticipant without stale closure issues
  useEffect(() => {
    return onSnapshot(doc(db, "meetings", meetingId), (snap) => {
      const data = snap.data();
      if (data?.muteAll && !isHost) {
        lpRef.current?.setMicrophoneEnabled(false).catch(() => {});
      }
      if (data?.aiToolsHiddenForGuests !== undefined) {
        setAiToolsHidden(!!data.aiToolsHiddenForGuests && !isHost);
      }
    });
  }, [meetingId, isHost]); // ← stable deps only — no more infinite loop

  // PET AI mute-all callback
  const handlePetAIMuteAll = (mute: boolean) => {
    lpRef.current?.setMicrophoneEnabled(!mute).catch(() => {});
  };

  // Host: broadcast mute signal
  const muteAll = async () => {
    await updateDoc(doc(db, "meetings", meetingId), { muteAll: true });
    setTimeout(() => updateDoc(doc(db, "meetings", meetingId), { muteAll: false }), 1500);
    toast.success("All participants muted");
  };

  const toggleAiTools = async () => {
    const next = !aiToolsHidden;
    await updateDoc(doc(db, "meetings", meetingId), { aiToolsHiddenForGuests: next });
    toast.success(next ? "AI tools hidden from guests" : "AI tools visible to guests");
  };

  // Leave / end call
  const handleLeave = async () => {
    recognitionRef.current?.stop();
    if (isHost) {
      await updateDoc(doc(db, "meetings", meetingId), { isActive: false }).catch(() => {});
    }
    setLocation("/");
  };

  // Live transcription (Web Speech API)
  const toggleTranscription = () => {
    type SRType = { continuous: boolean; interimResults: boolean; lang: string; onresult: ((e: { results: { isFinal: boolean; [0]: { transcript: string } }[] }) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void };
    const win = window as unknown as { SpeechRecognition?: new () => SRType; webkitSpeechRecognition?: new () => SRType };
    const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SR) { toast.error("Live transcription requires Chrome or Edge"); return; }
    if (isTranscribing) { recognitionRef.current?.stop(); setIsTranscribing(false); return; }
    const rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = "en-US";
    rec.onresult = (e) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript + (e.results[i].isFinal ? " " : "");
      setTranscript(t);
    };
    rec.onerror = (e) => { if (e.error !== "no-speech") console.warn("SR:", e.error); };
    rec.onend = () => { if (isTranscribing) rec.start(); };
    rec.start();
    recognitionRef.current = rec;
    setIsTranscribing(true);
  };

  const copyMeetingLink = () => {
    const base = `${window.location.origin}${import.meta.env.BASE_URL}`;
    const url = `${base}room/${meetingId}?roomName=${encodeURIComponent(roomName)}&title=${encodeURIComponent(title)}`;
    navigator.clipboard.writeText(url);
    toast.success("Link copied!");
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2500);
  };

  const sidePanel = chatOpen || participantsOpen || hostControlsOpen;

  // Button style helpers
  const btn = (active: boolean) =>
    `flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl text-xs font-medium transition-all border ${
      active
        ? "bg-primary/15 border-primary/40 text-primary"
        : "bg-card border-border text-foreground hover:bg-muted"
    }`;

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden select-none">

      {/* ── Top bar ── */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-background z-10 gap-2 shrink-0">
        <div className="flex items-center gap-2 shrink-0">
          <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg border ${
            isConnected ? "text-green-400 border-green-400/30 bg-green-400/8" : "text-yellow-400 border-yellow-400/30 bg-yellow-400/8"
          }`}>
            {isConnected
              ? <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
              : <Loader2 className="w-3 h-3 animate-spin shrink-0" />}
            <span>{isConnected ? "Live" : "Connecting…"}</span>
          </div>

          <span className="font-semibold text-sm truncate max-w-[130px]">{title}</span>

          <button onClick={copyMeetingLink} className={`flex items-center gap-1 text-xs px-2 py-1 rounded-lg border transition ${
            linkCopied ? "text-green-400 border-green-400/30 bg-green-400/10" : "text-muted-foreground border-border hover:bg-muted"
          }`}>
            <Copy className="w-3 h-3" />{linkCopied ? "Copied!" : "Copy Link"}
          </button>
        </div>

        {/* Note taker — center */}
        <div className="flex-1 max-w-xl hidden md:block mx-4">
          <NoteTaker transcript={transcript} isListening={isTranscribing} onToggle={toggleTranscription} isHostHidden={aiToolsHidden} />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Summarizer transcript={transcript} isHostHidden={aiToolsHidden} />
          <PetAI meetingId={meetingId} roomId={roomName} isHost={isHost} onMuteAll={handlePetAIMuteAll} />
        </div>
      </div>

      {/* Mobile note taker */}
      <div className="md:hidden px-2 py-1 border-b border-border shrink-0">
        <NoteTaker transcript={transcript} isListening={isTranscribing} onToggle={toggleTranscription} isHostHidden={aiToolsHidden} />
      </div>

      {/* ── Main area: video + sidebar ── */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        <div className="flex-1 relative overflow-hidden bg-black">
          {!isConnected && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-10 bg-black/80">
              <Loader2 className="w-10 h-10 animate-spin text-primary" />
              <p className="text-sm text-white/70">Connecting to room…</p>
            </div>
          )}
          {/* ✅ LiveKit GridLayout — works correctly once CSS is loaded */}
          <GridLayout tracks={tracks} style={{ height: "100%", width: "100%" }}>
            <ParticipantTile />
          </GridLayout>
        </div>

        {sidePanel && (
          <div className="w-72 shrink-0 border-l border-border overflow-hidden flex flex-col">
            {chatOpen && (
              <ChatPanel meetingId={meetingId} onClose={() => setChatOpen(false)} />
            )}
            {participantsOpen && !chatOpen && (
              <div className="flex flex-col h-full bg-card p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Users className="w-4 h-4 text-primary" />
                  <span className="font-semibold text-sm">Participants</span>
                </div>
                <p className="text-sm text-muted-foreground">{(room.numParticipants ?? 0) + 1} in this meeting</p>
              </div>
            )}
            {hostControlsOpen && isHost && !chatOpen && !participantsOpen && (
              <HostControlsPanel
                meetingId={meetingId}
                aiToolsHidden={aiToolsHidden}
                onClose={() => setHostControlsOpen(false)}
                onMuteAll={muteAll}
                onToggleAiTools={toggleAiTools}
              />
            )}
          </div>
        )}
      </div>

      {/* ── Control bar ── */}
      {/* LiveKit's own ControlBar handles mic / camera / screen share / leave */}
      {/* We add extra custom buttons (chat, hand, host) alongside it */}
      <div className="flex items-center justify-center gap-2 px-4 py-3 border-t border-border bg-background shrink-0 flex-wrap">
        {/* ✅ LiveKit's ControlBar — battle-tested, no custom state needed */}
        <ControlBar
          controls={{ microphone: true, camera: true, screenShare: true, leave: false, chat: false }}
          className="flex gap-2 items-center"
        />

        {/* Separator */}
        <div className="w-px h-8 bg-border mx-1" />

        {/* Raise Hand */}
        <button onClick={() => { setHandRaised((h) => !h); toast(handRaised ? "Hand lowered" : "✋ Hand raised!"); }} className={btn(handRaised)}>
          <Hand className="w-5 h-5" />
          <span className="hidden sm:block">{handRaised ? "Lower" : "Hand"}</span>
        </button>

        {/* Chat */}
        <button onClick={() => { setChatOpen((o) => !o); setParticipantsOpen(false); setHostControlsOpen(false); }} className={btn(chatOpen)}>
          <MessageCircle className="w-5 h-5" />
          <span className="hidden sm:block">Chat</span>
        </button>

        {/* Participants */}
        <button onClick={() => { setParticipantsOpen((o) => !o); setChatOpen(false); setHostControlsOpen(false); }} className={btn(participantsOpen)}>
          <Users className="w-5 h-5" />
          <span className="hidden sm:block">People</span>
        </button>

        {/* Host Controls */}
        {isHost && (
          <button onClick={() => { setHostControlsOpen((o) => !o); setChatOpen(false); setParticipantsOpen(false); }} className={btn(hostControlsOpen)}>
            <ShieldCheck className="w-5 h-5" />
            <span className="hidden sm:block">Host</span>
          </button>
        )}

        {/* Leave */}
        <button
          onClick={handleLeave}
          className="flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl text-xs font-medium border bg-destructive text-destructive-foreground border-transparent hover:opacity-90 transition-opacity"
        >
          <PhoneOff className="w-5 h-5" />
          <span className="hidden sm:block">Leave</span>
        </button>
      </div>

      <RoomAudioRenderer />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Outer: fetch LiveKit token → mount <LiveKitRoom>                   */
/* ------------------------------------------------------------------ */
export default function MeetingRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();
  const [token, setToken] = useState("");
  const [wsUrl, setWsUrl] = useState("");
  const [error, setError] = useState("");
  const didFetch = useRef(false); // prevent double-fetch in strict mode

  const params = new URLSearchParams(window.location.search);
  const roomName = params.get("roomName") || roomId || "";
  const title = params.get("title") || "Meeting";
  const isHost = params.get("host") === "true";

  useEffect(() => {
    if (loading) return;
    if (!user) { setLocation("/login"); return; }
    if (!roomId || !roomName) { setLocation("/"); return; }
    if (didFetch.current) return;
    didFetch.current = true;

    const participantName = user.displayName || user.email || `User-${user.uid.slice(0, 6)}`;
    const apiBase = import.meta.env.VITE_API_BASE_URL || "/api";

    fetch(`${apiBase}/livekit/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomName, participantName, isHost }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.token && data.wsUrl) {
          setToken(data.token);
          setWsUrl(data.wsUrl);
        } else {
          setError(data.error || "Failed to get meeting token");
        }
      })
      .catch(() => setError("Could not reach the meeting server."));
  }, [user, loading, roomId, roomName, isHost]);

  if (loading || (!token && !error)) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-3 bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Joining meeting…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4 bg-background">
        <WifiOff className="w-10 h-10 text-destructive" />
        <p className="text-destructive text-sm max-w-sm text-center">{error}</p>
        <button onClick={() => setLocation("/")} className="px-4 py-2 bg-muted rounded-lg text-sm hover:bg-accent transition">
          Back to Home
        </button>
      </div>
    );
  }

  return (
    <LiveKitRoom
      token={token}
      serverUrl={wsUrl}
      connect={true}
      video={true}
      audio={true}
      onDisconnected={() => setLocation("/")}
      style={{ height: "100vh" }}
    >
      <RoomInner
        meetingId={roomId!}
        roomName={roomName}
        title={title}
        isHost={isHost}
      />
    </LiveKitRoom>
  );
}
