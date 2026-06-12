import { useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/firebase";
import { doc, onSnapshot, updateDoc, increment } from "firebase/firestore";
import { toast } from "sonner";
import { Loader2, Users, Copy, Wifi, WifiOff, Mic, MicOff, Video, VideoOff, Monitor, MonitorOff, PhoneOff, MessageCircle, Hand, ShieldCheck } from "lucide-react";

import {
  LiveKitRoom,
  GridLayout,
  ParticipantTile,
  useTracks,
  useLocalParticipant,
  useRoomContext,
  RoomAudioRenderer,
  useConnectionState,
} from "@livekit/components-react";
import { Track, ConnectionState } from "livekit-client";

import NoteTaker from "@/components/NoteTaker";
import PetAI from "@/components/PetAI";
import ChatPanel from "@/components/ChatPanel";
import HostControlsPanel from "@/components/HostControlsPanel";
import Summarizer from "@/components/Summarizer";

/* ------------------------------------------------------------------ */
/* Inner component — runs inside <LiveKitRoom> so hooks work           */
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
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const room = useRoomContext();
  const connectionState = useConnectionState();

  // ✅ Read REAL LiveKit state — never use custom React state for these
  const {
    localParticipant,
    isMicrophoneEnabled,
    isCameraEnabled,
    isScreenShareEnabled,
  } = useLocalParticipant();

  // UI state (not media state)
  const [chatOpen, setChatOpen] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [hostControlsOpen, setHostControlsOpen] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [aiToolsHidden, setAiToolsHidden] = useState(false);
  const [forcedMute, setForcedMute] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // which button is loading
  const recognitionRef = useRef<{ stop: () => void; start: () => void } | null>(null);

  const isConnected = connectionState === ConnectionState.Connected;

  // All camera + screenshare tracks for the video grid
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false }
  );

  // Participant count in Firestore
  useEffect(() => {
    const ref = doc(db, "meetings", meetingId);
    updateDoc(ref, { participantCount: increment(1) }).catch(() => {});
    return () => { updateDoc(ref, { participantCount: increment(-1) }).catch(() => {}); };
  }, [meetingId]);

  // Listen for host "mute all" + AI tools visibility
  useEffect(() => {
    return onSnapshot(doc(db, "meetings", meetingId), (snap) => {
      const data = snap.data();
      if (data?.muteAll && !isHost && isConnected) {
        localParticipant?.setMicrophoneEnabled(false).catch(() => {});
        setForcedMute(false);
      }
      if (data?.aiToolsHiddenForGuests !== undefined) {
        setAiToolsHidden(!!data.aiToolsHiddenForGuests && !isHost);
      }
    });
  }, [meetingId, isHost, isConnected, localParticipant]);

  // ✅ Toggle mic — reads real state, catches all errors
  const toggleMic = async () => {
    if (forcedMute || !isConnected || !localParticipant) return;
    setBusy("mic");
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } catch {
      toast.error("Could not toggle microphone — check browser permissions");
    } finally {
      setBusy(null);
    }
  };

  // ✅ Toggle camera
  const toggleCamera = async () => {
    if (!isConnected || !localParticipant) return;
    setBusy("cam");
    try {
      await localParticipant.setCameraEnabled(!isCameraEnabled);
    } catch {
      toast.error("Could not toggle camera — check browser permissions");
    } finally {
      setBusy(null);
    }
  };

  // ✅ Toggle screen share
  const toggleScreen = async () => {
    if (!isConnected || !localParticipant) return;
    setBusy("screen");
    try {
      await localParticipant.setScreenShareEnabled(!isScreenShareEnabled);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (!msg.includes("Permission denied") && !msg.includes("NotAllowedError")) {
        toast.error("Screen share failed");
      }
    } finally {
      setBusy(null);
    }
  };

  // PET AI mutes everyone
  const handlePetAIMuteAll = (mute: boolean) => {
    setForcedMute(mute);
    if (isConnected && localParticipant) {
      localParticipant.setMicrophoneEnabled(!mute).catch(() => {});
    }
  };

  // Host: broadcast mute-all signal
  const muteAll = async () => {
    await updateDoc(doc(db, "meetings", meetingId), { muteAll: true });
    setTimeout(() => updateDoc(doc(db, "meetings", meetingId), { muteAll: false }), 1000);
    toast.success("All participants muted");
  };

  const toggleAiTools = async () => {
    const next = !aiToolsHidden;
    await updateDoc(doc(db, "meetings", meetingId), { aiToolsHiddenForGuests: next });
    toast.success(next ? "AI tools hidden from guests" : "AI tools visible to guests");
  };

  const raiseHand = () => {
    setHandRaised((h) => !h);
    toast(handRaised ? "Hand lowered" : "✋ Hand raised");
  };

  // Live transcription
  const toggleTranscription = () => {
    const win = window as unknown as { SpeechRecognition?: new () => { continuous: boolean; interimResults: boolean; lang: string; onresult: ((e: { results: { isFinal: boolean; [0]: { transcript: string } }[] }) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void }; webkitSpeechRecognition?: new () => { continuous: boolean; interimResults: boolean; lang: string; onresult: ((e: { results: { isFinal: boolean; [0]: { transcript: string } }[] }) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void } };
    const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SR) { toast.error("Speech recognition requires Chrome or Edge"); return; }
    if (isTranscribing) { recognitionRef.current?.stop(); setIsTranscribing(false); return; }
    const rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = "en-US";
    rec.onresult = (e) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) {
        t += e.results[i][0].transcript + (e.results[i].isFinal ? " " : "");
      }
      setTranscript(t);
    };
    rec.onerror = (e) => { if (e.error !== "no-speech") console.warn("SR error:", e.error); };
    rec.onend = () => { if (isTranscribing) rec.start(); };
    rec.start();
    recognitionRef.current = rec;
    setIsTranscribing(true);
  };

  const endCall = async () => {
    recognitionRef.current?.stop();
    room.disconnect();
    if (isHost) {
      await updateDoc(doc(db, "meetings", meetingId), { isActive: false }).catch(() => {});
    }
    setLocation("/");
  };

  const copyMeetingLink = () => {
    const base = `${window.location.origin}${import.meta.env.BASE_URL}`;
    const url = `${base}room/${meetingId}?roomName=${encodeURIComponent(roomName)}&title=${encodeURIComponent(title)}`;
    navigator.clipboard.writeText(url);
    toast.success("Link copied — share with anyone!");
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2500);
  };

  const sidePanel = chatOpen || participantsOpen || hostControlsOpen;

  const btnBase = "flex flex-col items-center gap-1 p-2.5 rounded-xl transition-all border text-xs font-medium";
  const btnOff = `${btnBase} bg-card border-border text-foreground hover:bg-muted disabled:opacity-40`;
  const btnOn = `${btnBase} bg-primary/15 border-primary/40 text-primary`;
  const btnDanger = `${btnBase} bg-destructive text-destructive-foreground border-transparent hover:opacity-90`;
  const btnMuted = `${btnBase} bg-destructive/10 border-destructive/30 text-destructive`;

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">

      {/* ── Top bar ── */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-background/80 backdrop-blur-sm z-10 gap-2">

        <div className="flex items-center gap-2 shrink-0">
          {/* Connection indicator */}
          <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg border ${
            isConnected
              ? "text-green-400 border-green-400/30 bg-green-400/8"
              : "text-yellow-400 border-yellow-400/30 bg-yellow-400/8"
          }`}>
            {isConnected ? <Wifi className="w-3 h-3" /> : <Loader2 className="w-3 h-3 animate-spin" />}
            <span className="hidden sm:inline">{isConnected ? "Live" : "Connecting…"}</span>
          </div>
          <span className="font-semibold text-sm truncate max-w-[140px]">{title}</span>
          <button
            onClick={copyMeetingLink}
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition ${
              linkCopied ? "text-green-400 border-green-400/30 bg-green-400/10" : "text-muted-foreground border-border hover:bg-muted"
            }`}
          >
            <Copy className="w-3 h-3" /> {linkCopied ? "Copied!" : "Copy Link"}
          </button>
        </div>

        {/* Note taker — top-middle */}
        <div className="flex-1 max-w-xl hidden md:block">
          <NoteTaker transcript={transcript} isListening={isTranscribing} onToggle={toggleTranscription} isHostHidden={aiToolsHidden} />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Summarizer transcript={transcript} isHostHidden={aiToolsHidden} />
          <PetAI meetingId={meetingId} roomId={roomName} isHost={isHost} onMuteAll={handlePetAIMuteAll} />
        </div>
      </div>

      {/* Mobile note taker */}
      <div className="md:hidden px-2 py-1 border-b border-border">
        <NoteTaker transcript={transcript} isListening={isTranscribing} onToggle={toggleTranscription} isHostHidden={aiToolsHidden} />
      </div>

      {/* ── Main area ── */}
      <div className="flex-1 flex overflow-hidden min-h-0">

        {/* Video grid */}
        <div className="flex-1 p-2 overflow-hidden min-h-0 relative">
          {!isConnected && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-10 bg-background/60 backdrop-blur-sm rounded-xl">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Connecting to room…</p>
            </div>
          )}
          <GridLayout tracks={tracks} style={{ height: "100%", width: "100%" }}>
            <ParticipantTile />
          </GridLayout>
        </div>

        {/* Side panel */}
        {sidePanel && (
          <div className="w-72 shrink-0 border-l border-border overflow-hidden">
            {chatOpen && <ChatPanel meetingId={meetingId} onClose={() => setChatOpen(false)} />}
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
      <div className="flex items-center justify-center gap-2 px-4 py-3 border-t border-border bg-background/80 backdrop-blur-sm flex-wrap">

        {/* Mic */}
        <button
          onClick={toggleMic}
          disabled={!isConnected || busy === "mic" || forcedMute}
          className={forcedMute || !isMicrophoneEnabled ? btnMuted : btnOff}
          title={forcedMute ? "Muted by AI / host" : isMicrophoneEnabled ? "Mute" : "Unmute"}
        >
          {busy === "mic" ? <Loader2 className="w-5 h-5 animate-spin" /> :
           (isMicrophoneEnabled && !forcedMute) ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
          <span className="hidden sm:block">{forcedMute ? "Muted" : isMicrophoneEnabled ? "Mute" : "Unmute"}</span>
        </button>

        {/* Camera */}
        <button
          onClick={toggleCamera}
          disabled={!isConnected || busy === "cam"}
          className={isCameraEnabled ? btnOff : btnMuted}
          title={isCameraEnabled ? "Stop video" : "Start video"}
        >
          {busy === "cam" ? <Loader2 className="w-5 h-5 animate-spin" /> :
           isCameraEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
          <span className="hidden sm:block">{isCameraEnabled ? "Stop Video" : "Start Video"}</span>
        </button>

        {/* Screen share */}
        <button
          onClick={toggleScreen}
          disabled={!isConnected || busy === "screen"}
          className={isScreenShareEnabled ? btnOn : btnOff}
          title={isScreenShareEnabled ? "Stop sharing" : "Share screen"}
        >
          {busy === "screen" ? <Loader2 className="w-5 h-5 animate-spin" /> :
           isScreenShareEnabled ? <MonitorOff className="w-5 h-5" /> : <Monitor className="w-5 h-5" />}
          <span className="hidden sm:block">{isScreenShareEnabled ? "Stop Share" : "Share Screen"}</span>
        </button>

        {/* Raise hand */}
        <button onClick={raiseHand} className={handRaised ? btnOn : btnOff}>
          <Hand className="w-5 h-5" />
          <span className="hidden sm:block">{handRaised ? "Lower Hand" : "Raise Hand"}</span>
        </button>

        {/* Chat */}
        <button
          onClick={() => { setChatOpen((o) => !o); setParticipantsOpen(false); setHostControlsOpen(false); }}
          className={chatOpen ? btnOn : btnOff}
        >
          <MessageCircle className="w-5 h-5" />
          <span className="hidden sm:block">Chat</span>
        </button>

        {/* Participants */}
        <button
          onClick={() => { setParticipantsOpen((o) => !o); setChatOpen(false); setHostControlsOpen(false); }}
          className={participantsOpen ? btnOn : btnOff}
        >
          <Users className="w-5 h-5" />
          <span className="hidden sm:block">People</span>
        </button>

        {/* Host controls */}
        {isHost && (
          <button
            onClick={() => { setHostControlsOpen((o) => !o); setChatOpen(false); setParticipantsOpen(false); }}
            className={hostControlsOpen ? btnOn : btnOff}
          >
            <ShieldCheck className="w-5 h-5 text-primary" />
            <span className="hidden sm:block">Host</span>
          </button>
        )}

        {/* Leave */}
        <button onClick={endCall} className={btnDanger}>
          <PhoneOff className="w-5 h-5" />
          <span className="hidden sm:block">Leave</span>
        </button>
      </div>

      <RoomAudioRenderer />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Outer shell — fetches LiveKit token, then mounts LiveKitRoom        */
/* ------------------------------------------------------------------ */
export default function MeetingRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();
  const [token, setToken] = useState("");
  const [wsUrl, setWsUrl] = useState("");
  const [error, setError] = useState("");
  const [fetching, setFetching] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const roomName = params.get("roomName") || roomId || "";
  const title = params.get("title") || "Meeting";
  const isHost = params.get("host") === "true";

  useEffect(() => {
    if (loading || fetching) return;
    if (!user) { setLocation("/login"); return; }
    if (!roomId || !roomName) { setLocation("/"); return; }

    setFetching(true);
    const participantName = user.displayName || user.email || `User-${user.uid.slice(0, 6)}`;

    // Use configurable API base (works on both Replit dev and GitHub Pages prod)
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
      .catch(() => setError("Could not reach the meeting server. Make sure you're connected."))
      .finally(() => setFetching(false));
  }, [user, loading, roomId, roomName, isHost]);

  if (loading || fetching) {
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
