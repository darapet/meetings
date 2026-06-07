import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";
import { Loader2, Video, Mail, Lock, User } from "lucide-react";

type Mode = "login" | "signup" | "guest";

export default function LoginPage() {
  const { signIn, signUp, signInAsGuest } = useAuth();
  const [, setLocation] = useLocation();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);

  const handle = async () => {
    setLoading(true);
    try {
      if (mode === "guest") {
        if (!displayName.trim()) { toast.error("Enter your name"); return; }
        await signInAsGuest(displayName.trim());
      } else if (mode === "login") {
        await signIn(email, password);
      } else {
        if (!displayName.trim()) { toast.error("Enter your name"); return; }
        await signUp(email, password, displayName.trim());
      }
      setLocation("/");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Authentication failed";
      toast.error(msg.replace("Firebase: ", "").replace(/\(auth.*\)\.?/, "").trim());
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md fade-in">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
            <Video className="w-5 h-5 text-primary-foreground" />
          </div>
          <span className="text-2xl font-bold text-foreground">Dara Meetings</span>
        </div>

        <div className="bg-card border border-border rounded-2xl p-8 shadow-xl">
          {/* Tabs */}
          <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6">
            {(["login", "signup", "guest"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${
                  mode === m
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m === "login" ? "Sign In" : m === "signup" ? "Sign Up" : "Guest"}
              </button>
            ))}
          </div>

          <div className="space-y-4">
            {(mode === "signup" || mode === "guest") && (
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  className="w-full pl-10 pr-4 py-3 bg-muted border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="Your name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handle()}
                />
              </div>
            )}

            {mode !== "guest" && (
              <>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="email"
                    className="w-full pl-10 pr-4 py-3 bg-muted border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    placeholder="Email address"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handle()}
                  />
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="password"
                    className="w-full pl-10 pr-4 py-3 bg-muted border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handle()}
                  />
                </div>
              </>
            )}

            <button
              onClick={handle}
              disabled={loading}
              className="w-full py-3 bg-primary text-primary-foreground rounded-lg font-semibold text-sm hover:opacity-90 transition disabled:opacity-50 flex items-center justify-center gap-2 btn-glow"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {mode === "login" ? "Sign In" : mode === "signup" ? "Create Account" : "Join as Guest"}
            </button>
          </div>

          {mode === "guest" && (
            <p className="mt-4 text-xs text-center text-muted-foreground">
              Guest sessions are temporary. Sign up for a full account to save your history.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
