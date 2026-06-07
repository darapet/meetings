import { useEffect, useRef, useState } from "react";
import { db } from "@/lib/firebase";
import {
  collection, addDoc, serverTimestamp, query,
  orderBy, onSnapshot, limit,
} from "firebase/firestore";
import { useAuth } from "@/lib/auth-context";
import { Send, X, MessageCircle } from "lucide-react";

interface Message {
  id: string;
  text: string;
  senderName: string;
  senderUid: string;
  createdAt: { seconds: number } | null;
}

interface Props {
  meetingId: string;
  onClose: () => void;
}

export default function ChatPanel({ meetingId, onClose }: Props) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query(
      collection(db, "meetings", meetingId, "chat"),
      orderBy("createdAt", "asc"),
      limit(200)
    );
    return onSnapshot(q, (snap) => {
      setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Message)));
    });
  }, [meetingId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    if (!text.trim() || !user) return;
    const msg = text.trim();
    setText("");
    await addDoc(collection(db, "meetings", meetingId, "chat"), {
      text: msg,
      senderName: user.displayName || user.email || "Participant",
      senderUid: user.uid,
      createdAt: serverTimestamp(),
    });
  };

  return (
    <div className="flex flex-col h-full bg-card border-l border-border slide-in-right">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <MessageCircle className="w-4 h-4 text-primary" />
          <span className="font-semibold text-sm">Chat</span>
        </div>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-muted transition">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-xs text-center text-muted-foreground mt-4">
            No messages yet. Say hi!
          </p>
        )}
        {messages.map((m) => {
          const isMe = m.senderUid === user?.uid;
          return (
            <div key={m.id} className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}>
              <span className="text-xs text-muted-foreground mb-0.5">{m.senderName}</span>
              <div
                className={`px-3 py-2 rounded-xl text-sm max-w-[85%] ${
                  isMe
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-muted text-foreground rounded-bl-sm"
                }`}
              >
                {m.text}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-3 py-3 border-t border-border flex gap-2">
        <input
          className="flex-1 px-3 py-2 bg-muted border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          placeholder="Message…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
        />
        <button
          onClick={send}
          disabled={!text.trim()}
          className="p-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition disabled:opacity-50"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
