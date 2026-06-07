import { useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/firebase";
import { doc, onSnapshot, updateDoc, increment } from "firebase/firestore";
import { toast } from "sonner";
import { Loader2, Users, Copy } from "lucide-react";

import {
  LiveKitRoom,
  GridLayout,
  ParticipantTile,
  useTracks,
  useLocalParticipant,
  useRoomContext,
  RoomAudioRenderer,
  ControlBar as LKControlBar,
} from "@livekit/components-react";
import { Track, RoomEvent, type Room } from "livekit-client";

import NoteTaker from "@/components/NoteTaker";
import PetAI from "@/components/PetAI";
import ControlBar from "@/components/ControlBar";
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
  const { localParticipant } = useLocalParticipant();

  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [screenSharing, setScreenSharing] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [hostControlsOpen, setHostControlsOpen] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [aiToolsHidden, setAiToolsHidden] = useState(false);
  const [forcedMute, setForcedMute] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // All tracks for the grid
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false }
  );

  // Increment participant count on join, decrement on leave
  useEffect(() => {
    const ref = doc(db, "meetings", meetingId);
    updateDoc(ref, { participantCount: increment(1) }).catch(() => {});
    return () => {
      updateDoc(ref, { participantCount: increment(-1) }).catch(() => {});
    };
  }, [meetingId]);

  // Listen for host "mute all" events
  useEffect(() => {
    const ref = doc(db, "meetings", meetingId);
    return onSnapshot(ref, (snap) => {
      const data = snap.data();
      if (data?.muteAll && !isHost) {
        localParticipant.setMicrophoneEnabled(false);
        setMicEnabled(false);
        setForcedMute(false); // allow re-enable after mute-all
      }
      if (data?.aiToolsHiddenForGuests !== undefined) {
        setAiToolsHidden(data.aiToolsHiddenForGuests && !isHost);
      }
    });
  }, [meetingId, isHost, localParticipant]);

  // Screen share: real-time, no refresh needed — LiveKit handles it
  const toggleScreen = async () => {
    try {
      await localParticipant.setScreenShareEnabled(!screenSharing);
      setScreenSharing(!screenSharing);
    } catch {
      toast.error("Screen share permission denied");
    }
  };

  const toggleMic = async () => {
    if (forcedMute) return;
    await localParticipant.setMicrophoneEnabled(!micEnabled);
    setMicEnabled(!micEnabled);
  };

  const toggleCamera = async () => {
    await localParticipant.setCameraEnabled(!cameraEnabled);
    setCameraEnabled(!cameraEnabled);
  };

  // PET AI forces mute on all participants
  const handlePetAIMuteAll = (mute: boolean) => {
    setForcedMute(mute);
    localParticipant.setMicrophoneEnabled(!mute).catch(() => {});
    if (!mute) setMicEnabled(true);
  };

  // Host: mute all
  const muteAll = async () => {
    await updateDoc(doc(db, "meetings", meetingId), { muteAll: true });
    setTimeout(() => updateDoc(doc(db, "meetings", meetingId), { muteAll: false }), 1000);
    toast.success("All participants muted");
  };

  // Host: toggle AI tools visibility
  const toggleAiTools = async () => {
    const next = !aiToolsHidden;
    await updateDoc(doc(db, "meetings", meetingId), { aiToolsHiddenForGuests: next });
    toast.success(next ? "AI tools hidden from guests" : "AI tools shown to guests");
  };

  const raiseHand = () => {
    setHandRaised(!handRaised);
    toast(handRaised ? "Hand lowered" : "✋ Hand raised — visible to host");
  };

  // Live transcription via Web Speech API
  const toggleTranscription = () => {
    if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
      toast.error("Speech recognition not supported in this browser. Use Chrome.");
      return;
    }
    if (isTranscribing) {
      recognitionRef.current?.stop();
      setIsTranscribing(false);
      return;
    }
    const SR = (window as unknown as { SpeechRecognition?: typeof SpeechRecognition; webkitSpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition
      || (window as unknown as { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          t += e.results[i][0].transcript + " ";
        } else {
          t += e.results[i][0].transcript;
        }
      }
      setTranscript(t);
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech") return;
      if (e.error === "audio-capture") {
        setTranscript((p) => p + " [cannot transcribe due to poor grammar or conversation] ");
      }
    };
    rec.onend = () => {
      if (isTranscribing) rec.start(); // auto-restart
    };
    rec.start();
    recognitionRef.current = rec;
    setIsTranscribing(true);
  };

  const endCall = async () => {
    recognitionRef.current?.stop();
    room.disconnect();
    if (isHost) {
      await updateDoc(doc(db, "meetings", meetingId), { isActive: false });
    }
    setLocation("/");
  };

  const copyMeetingId = () => {
    navigator.clipboard.writeText(meetingId);
    toast.success("Meeting ID copied!");
  };

  const sidePanel = chatOpen || participantsOpen || hostControlsOpen;

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-background/80 backdrop-blur-sm z-10">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm truncate max-w-[180px]">{title}</span>
          <button
            onClick={copyMeetingId}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition px-2 py-1 rounded-lg hover:bg-muted"
            title="Copy meeting ID"
          >
            <Copy className="w-3 h-3" /> {meetingId.slice(0, 8)}…
          </button>
        </div>

        {/* Note Taker (top-middle) */}
        <div className="flex-1 max-w-xl mx-4 hidden md:block">
          <NoteTaker
            transcript={transcript}
            isListening={isTranscribing}
            onToggle={toggleTranscription}
            isHostHidden={aiToolsHidden}
          />
        </div>

        <div className="flex items-center gap-2">
          <Summarizer transcript={transcript} isHostHidden={aiToolsHidden} />
          <PetAI
            meetingId={meetingId}
            roomId={roomName}
            isHost={isHost}
            onMuteAll={handlePetAIMuteAll}
          />
        </div>
      </div>

      {/* Mobile note taker */}
      <div className="md:hidden px-2 py-1 border-b border-border">
        <NoteTaker
          transcript={transcript}
          isListening={isTranscribing}
          onToggle={toggleTranscription}
          isHostHidden={aiToolsHidden}
        />
      </div>

      {/* Main area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Video grid */}
        <div className="flex-1 p-2 overflow-hidden">
          <GridLayout tracks={tracks} style={{ height: "100%" }}>
            <ParticipantTile />
          </GridLayout>
        </div>

        {/* Side panels */}
        {sidePanel && (
          <div className="w-72 shrink-0 border-l border-border">
            {chatOpen && (
              <ChatPanel meetingId={meetingId} onClose={() => setChatOpen(false)} />
            )}
            {participantsOpen && !chatOpen && (
              <div className="flex flex-col h-full bg-card p-4">
                <div className="flex items-center gap-2 mb-4">
                  <Users className="w-4 h-4 text-primary" />
                  <span className="font-semibold text-sm">Participants</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {room.numParticipants + 1} in this meeting
                </div>
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

      {/* Control bar */}
      <ControlBar
        micEnabled={micEnabled}
        cameraEnabled={cameraEnabled}
        screenSharing={screenSharing}
        chatOpen={chatOpen}
        participantsOpen={participantsOpen}
        isHost={isHost}
        handRaised={handRaised}
        forcedMute={forcedMute}
        onToggleMic={toggleMic}
        onToggleCamera={toggleCamera}
        onToggleScreen={toggleScreen}
        onToggleChat={() => { setChatOpen(!chatOpen); setParticipantsOpen(false); setHostControlsOpen(false); }}
        onToggleParticipants={() => { setParticipantsOpen(!participantsOpen); setChatOpen(false); setHostControlsOpen(false); }}
        onRaiseHand={raiseHand}
        onEndCall={endCall}
        onHostControls={() => { setHostControlsOpen(!hostControlsOpen); setChatOpen(false); setParticipantsOpen(false); }}
      />

      <RoomAudioRenderer />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Outer shell — fetches token then mounts LiveKitRoom                 */
/* ------------------------------------------------------------------ */
export default function MeetingRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();
  const [token, setToken] = useState("");
  const [wsUrl, setWsUrl] = useState("");
  const [error, setError] = useState("");

  // Parse URL query params
  const params = new URLSearchParams(window.location.search);
  const roomName = params.get("roomName") || roomId || "";
  const title = params.get("title") || "Meeting";
  const isHost = params.get("host") === "true";

  useEffect(() => {
    if (loading) return;
    if (!user) { setLocation("/login"); return; }
    if (!roomId || !roomName) { setLocation("/"); return; }

    const participantName = user.displayName || user.email || `User-${user.uid.slice(0, 6)}`;
    fetch("/api/livekit/token", {
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
          setError("Failed to get meeting token. Is the server running?");
        }
      })
      .catch(() => setError("Could not connect to meeting server."));
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
        <p className="text-destructive text-sm">{error}</p>
        <button onClick={() => setLocation("/")} className="px-4 py-2 bg-muted rounded-lg text-sm">
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
