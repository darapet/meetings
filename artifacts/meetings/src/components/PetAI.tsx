import { useEffect, useRef, useState } from "react";
import { db } from "@/lib/firebase";
import { doc, onSnapshot, setDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { useAuth } from "@/lib/auth-context";
import { useAiChat } from "@workspace/api-client-react";
import { toast } from "sonner";
import { Bot, X, Send, Square, Loader2, Volume2, VolumeX } from "lucide-react";

interface PetAIState {
  active: boolean;
  summonerUid: string;
  summonerName: string;
  messages: { role: string; content: string }[];
  speaking: boolean;
}

interface Props {
  meetingId: string;
  roomId: string;
  isHost: boolean;
  onMuteAll: (mute: boolean) => void;
}

export default function PetAI({ meetingId, roomId, isHost, onMuteAll }: Props) {
  const { user } = useAuth();
  const [state, setState] = useState<PetAIState | null>(null);
  const [input, setInput] = useState("");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const synthRef = useRef<SpeechSynthesisUtterance | null>(null);
  const aiChat = useAiChat();
  const petRef = doc(db, "meetings", meetingId, "petAI", "session");

  // Listen to PET AI state for everyone
  useEffect(() => {
    const unsub = onSnapshot(petRef, (snap) => {
      if (snap.exists()) {
        setState(snap.data() as PetAIState);
      } else {
        setState(null);
        // Restore mics when AI closes
        onMuteAll(false);
        window.speechSynthesis?.cancel();
      }
    });
    return unsub;
  }, [meetingId]);

  // Auto-mute all when AI is active/speaking
  useEffect(() => {
    if (state?.active) {
      onMuteAll(true);
    } else {
      onMuteAll(false);
    }
  }, [state?.active]);

  // Speak new AI messages
  useEffect(() => {
    if (!state?.messages || !voiceEnabled || !state.speaking) return;
    const last = state.messages[state.messages.length - 1];
    if (last?.role === "assistant") {
      window.speechSynthesis?.cancel();
      const utt = new SpeechSynthesisUtterance(last.content);
      utt.rate = 1.0;
      utt.pitch = 1.0;
      const voices = window.speechSynthesis.getVoices();
      const preferred = voices.find(v => v.name.includes("Google") && v.lang.startsWith("en"));
      if (preferred) utt.voice = preferred;
      utt.onend = () => {
        if (state.summonerUid === user?.uid) {
          setDoc(petRef, { ...state, speaking: false }, { merge: true });
        }
      };
      synthRef.current = utt;
      window.speechSynthesis.speak(utt);
    }
  }, [state?.messages?.length, state?.speaking, voiceEnabled]);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state?.messages?.length]);

  const summonPetAI = async () => {
    if (!user) return;
    await setDoc(petRef, {
      active: true,
      summonerUid: user.uid,
      summonerName: user.displayName || user.email || "Participant",
      messages: [],
      speaking: false,
      summonedAt: serverTimestamp(),
    });
    toast.success("PET AI summoned — everyone can see it now");
  };

  const closePetAI = async () => {
    if (state?.summonerUid !== user?.uid && !isHost) {
      toast.error("Only the summoner or host can close PET AI");
      return;
    }
    window.speechSynthesis?.cancel();
    await deleteDoc(petRef);
  };

  const stopSpeaking = () => {
    window.speechSynthesis?.cancel();
    if (state && state.summonerUid === user?.uid) {
      setDoc(petRef, { ...state, speaking: false }, { merge: true });
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || !state || !user) return;
    if (state.summonerUid !== user.uid) {
      toast.error("Only the summoner can send messages to PET AI");
      return;
    }
    const userMsg = input.trim();
    setInput("");

    const newMessages = [...state.messages, { role: "user", content: userMsg }];
    await setDoc(petRef, { ...state, messages: newMessages }, { merge: true });

    aiChat.mutate(
      {
        data: {
          message: userMsg,
          roomId,
          conversationHistory: state.messages as { role: string; content: string }[],
        },
      },
      {
        onSuccess: async (data) => {
          const updated = [
            ...newMessages,
            { role: "assistant", content: data.reply },
          ];
          await setDoc(petRef, { ...state, messages: updated, speaking: true }, { merge: true });
        },
        onError: () => toast.error("PET AI failed to respond"),
      }
    );
  };

  // Summon button — shown to everyone when AI is not active
  if (!state?.active) {
    return (
      <button
        onClick={summonPetAI}
        className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl font-semibold text-sm hover:opacity-90 transition btn-glow"
        title="Summon PET AI — visible to all participants"
      >
        <Bot className="w-4 h-4" />
        PET AI
      </button>
    );
  }

  // Full PET AI terminal — visible to everyone
  return (
    <div className="fixed inset-0 bg-background/90 backdrop-blur-md z-40 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-card border border-primary/40 rounded-2xl shadow-2xl pet-active overflow-hidden fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-primary/5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
              <Bot className="w-4 h-4 text-primary-foreground" />
            </div>
            <div>
              <div className="font-bold text-sm">PET AI</div>
              <div className="text-xs text-muted-foreground">
                Summoned by {state.summonerName} · All mics muted
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {state.speaking && (
              <button
                onClick={stopSpeaking}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-destructive/20 text-destructive border border-destructive/30 rounded-lg text-xs font-medium hover:bg-destructive/30 transition"
              >
                <Square className="w-3 h-3" /> Stop
              </button>
            )}
            <button
              onClick={() => setVoiceEnabled(!voiceEnabled)}
              className="p-2 rounded-lg hover:bg-muted transition text-muted-foreground"
              title={voiceEnabled ? "Disable voice" : "Enable voice"}
            >
              {voiceEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>
            {(state.summonerUid === user?.uid || isHost) && (
              <button
                onClick={closePetAI}
                className="p-2 rounded-lg hover:bg-destructive/10 transition text-muted-foreground hover:text-destructive"
                title="End conversation"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="h-72 overflow-y-auto px-5 py-4 space-y-4 font-mono text-sm bg-background/50">
          {state.messages.length === 0 && (
            <div className="text-muted-foreground text-center mt-8">
              PET AI is ready. Ask anything — everyone can see this conversation.
            </div>
          )}
          {state.messages.map((m, i) => (
            <div key={i} className={`flex gap-3 ${m.role === "assistant" ? "items-start" : "items-start justify-end"}`}>
              {m.role === "assistant" && (
                <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="w-3 h-3 text-primary-foreground" />
                </div>
              )}
              <div
                className={`px-3 py-2 rounded-xl text-xs leading-relaxed max-w-[85%] ${
                  m.role === "assistant"
                    ? "bg-primary/10 text-foreground border border-primary/20"
                    : "bg-muted text-foreground"
                }`}
              >
                {m.content}
                {m.role === "assistant" && i === state.messages.length - 1 && state.speaking && (
                  <span className="cursor-blink ml-1 text-primary">█</span>
                )}
              </div>
            </div>
          ))}
          {aiChat.isPending && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="text-xs">PET AI is thinking…</span>
            </div>
          )}
          <div ref={scrollRef} />
        </div>

        {/* Input — only summoner can type */}
        <div className="px-4 py-3 border-t border-border">
          {state.summonerUid === user?.uid ? (
            <div className="flex gap-2">
              <input
                className="flex-1 px-3 py-2 bg-muted border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="Ask PET AI anything…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
                disabled={aiChat.isPending}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || aiChat.isPending}
                className="p-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition disabled:opacity-50"
              >
                {aiChat.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
          ) : (
            <div className="text-xs text-center text-muted-foreground py-1">
              Viewing {state.summonerName}'s conversation with PET AI
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
