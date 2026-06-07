import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/firebase";
import {
  collection, addDoc, serverTimestamp, query, where, onSnapshot,
  limit, orderBy, doc, getDoc,
} from "firebase/firestore";
import { toast } from "sonner";
import {
  Video, Plus, LogIn, LogOut, Users, Clock, Loader2,
  Zap, Globe, Lock, Link, Check,
} from "lucide-react";

interface MeetingDoc {
  id: string;
  title: string;
  hostName: string;
  roomName: string;
  createdAt: { seconds: number } | null;
  participantCount: number;
  isActive: boolean;
}

export default function LandingPage() {
  const { user, logOut, loading } = useAuth();
  const [, setLocation] = useLocation();
  const [title, setTitle] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [activeMeetings, setActiveMeetings] = useState<MeetingDoc[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, "meetings"),
      where("isActive", "==", true),
      orderBy("createdAt", "desc"),
      limit(5)
    );
    const unsub = onSnapshot(q, (snap) => {
      setActiveMeetings(snap.docs.map((d) => ({ id: d.id, ...d.data() } as MeetingDoc)));
    });
    return unsub;
  }, [user]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        {/* Hero */}
        <div className="text-center max-w-2xl mx-auto fade-in">
          <div className="flex items-center justify-center gap-3 mb-6">
            <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center">
              <Video className="w-7 h-7 text-primary-foreground" />
            </div>
            <h1 className="text-4xl font-bold">Dara Meetings</h1>
          </div>
          <p className="text-xl text-muted-foreground mb-4">
            Crystal-clear video meetings for up to <span className="text-primary font-semibold">1,000 people</span>
          </p>
          <p className="text-muted-foreground mb-10">
            Real-time screen sharing • PET AI assistant • Live transcription • Smart summaries
          </p>

          {/* Features */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
            {[
              { icon: Users, label: "1,000 participants", desc: "Powered by LiveKit" },
              { icon: Zap, label: "PET AI assistant", desc: "Visible to everyone" },
              { icon: Globe, label: "Live transcription", desc: "Auto note-taking" },
            ].map(({ icon: Icon, label, desc }) => (
              <div key={label} className="bg-card border border-border rounded-xl p-4 text-left">
                <Icon className="w-5 h-5 text-primary mb-2" />
                <div className="font-semibold text-sm">{label}</div>
                <div className="text-xs text-muted-foreground">{desc}</div>
              </div>
            ))}
          </div>

          <button
            onClick={() => setLocation("/login")}
            className="px-8 py-3 bg-primary text-primary-foreground rounded-xl font-semibold hover:opacity-90 transition btn-glow"
          >
            Get Started — It's Free
          </button>
        </div>
      </div>
    );
  }

  const createMeeting = async () => {
    if (!title.trim()) { toast.error("Enter a meeting title"); return; }
    if (activeMeetings.length >= 5) { toast.error("Maximum 5 concurrent meetings reached"); return; }
    setCreating(true);
    try {
      const roomName = `room-${Date.now().toString(36)}`;
      const ref = await addDoc(collection(db, "meetings"), {
        title: title.trim(),
        hostUid: user.uid,
        hostName: user.displayName || user.email || "Host",
        roomName,
        createdAt: serverTimestamp(),
        participantCount: 0,
        isActive: true,
        maxParticipants: 1000,
      });
      setLocation(`/room/${ref.id}?host=true&roomName=${roomName}&title=${encodeURIComponent(title.trim())}`);
    } catch {
      toast.error("Failed to create meeting");
    } finally {
      setCreating(false);
    }
  };

  const joinMeeting = async () => {
    const code = joinCode.trim();
    if (!code) { toast.error("Enter a meeting code or ID"); return; }
    setJoining(true);
    try {
      // Try by meeting ID first, then by roomName
      let meetingId = code;
      let roomName = code;
      let meetingTitle = "Meeting";
      try {
        const snap = await getDoc(doc(db, "meetings", code));
        if (snap.exists()) {
          const data = snap.data();
          roomName = data.roomName;
          meetingTitle = data.title;
        }
      } catch {
        // might be a roomName directly
      }
      setLocation(`/room/${meetingId}?roomName=${roomName}&title=${encodeURIComponent(meetingTitle)}`);
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <nav className="border-b border-border px-4 md:px-8 py-4 flex items-center justify-between sticky top-0 bg-background/80 backdrop-blur-sm z-10">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <Video className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="font-bold text-lg">Dara Meetings</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground hidden sm:block">
            {user.displayName || user.email}
          </span>
          <button
            onClick={() => logOut()}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition"
          >
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto p-4 md:p-8 fade-in">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          {/* Create Meeting */}
          <div className="bg-card border border-border rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-4">
              <Plus className="w-5 h-5 text-primary" />
              <h2 className="font-semibold text-lg">New Meeting</h2>
            </div>
            <input
              className="w-full px-4 py-3 bg-muted border border-border rounded-lg text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="Meeting title..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createMeeting()}
            />
            <button
              onClick={createMeeting}
              disabled={creating}
              className="w-full py-3 bg-primary text-primary-foreground rounded-lg font-semibold text-sm hover:opacity-90 transition disabled:opacity-50 flex items-center justify-center gap-2 btn-glow"
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Video className="w-4 h-4" />}
              {creating ? "Creating…" : "Start Meeting"}
            </button>
          </div>

          {/* Join Meeting */}
          <div className="bg-card border border-border rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-4">
              <LogIn className="w-5 h-5 text-primary" />
              <h2 className="font-semibold text-lg">Join Meeting</h2>
            </div>
            <input
              className="w-full px-4 py-3 bg-muted border border-border rounded-lg text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="Meeting ID or code..."
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && joinMeeting()}
            />
            <button
              onClick={joinMeeting}
              disabled={joining}
              className="w-full py-3 bg-secondary text-secondary-foreground border border-border rounded-lg font-semibold text-sm hover:bg-muted transition disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {joining ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
              {joining ? "Joining…" : "Join Meeting"}
            </button>
          </div>
        </div>

        {/* Active Meetings */}
        {activeMeetings.length > 0 && (
          <div>
            <h2 className="font-semibold mb-3 text-sm text-muted-foreground uppercase tracking-wide">
              Active Meetings ({activeMeetings.length}/5)
            </h2>
            <div className="space-y-3">
              {activeMeetings.map((m) => {
                const copyLink = (e: React.MouseEvent) => {
                  e.stopPropagation();
                  const base = window.location.origin + (import.meta.env.BASE_URL || "/");
                  const url = `${base}room/${m.id}?roomName=${encodeURIComponent(m.roomName)}&title=${encodeURIComponent(m.title)}`;
                  navigator.clipboard.writeText(url);
                  setCopiedId(m.id);
                  toast.success("Meeting link copied!");
                  setTimeout(() => setCopiedId(null), 2500);
                };
                return (
                <div
                  key={m.id}
                  className="bg-card border border-border rounded-xl p-4 flex items-center justify-between hover:border-primary/40 transition cursor-pointer"
                  onClick={() =>
                    setLocation(`/room/${m.id}?roomName=${m.roomName}&title=${encodeURIComponent(m.title)}`)
                  }
                >
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    <div>
                      <div className="font-medium text-sm">{m.title}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                        <Users className="w-3 h-3" /> {m.participantCount} participants
                        <span>·</span>
                        <span>Host: {m.hostName}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={copyLink}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                        copiedId === m.id
                          ? "text-green-400 border-green-400/30 bg-green-400/10"
                          : "text-muted-foreground border-border hover:bg-muted"
                      }`}
                      title="Copy shareable link"
                    >
                      {copiedId === m.id ? <Check className="w-3 h-3" /> : <Link className="w-3 h-3" />}
                      {copiedId === m.id ? "Copied!" : "Copy Link"}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setLocation(`/room/${m.id}?roomName=${m.roomName}&title=${encodeURIComponent(m.title)}`); }}
                      className="px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:opacity-90 transition"
                    >
                      Join
                    </button>
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Stats footer */}
        <div className="mt-8 grid grid-cols-3 gap-4">
          {[
            { icon: Users, label: "Max per meeting", value: "1,000" },
            { icon: Clock, label: "Concurrent meetings", value: "5" },
            { icon: Lock, label: "Encrypted", value: "E2EE" },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="bg-card border border-border rounded-xl p-4 text-center">
              <Icon className="w-4 h-4 text-primary mx-auto mb-1" />
              <div className="text-lg font-bold">{value}</div>
              <div className="text-xs text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
