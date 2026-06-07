import { useState } from "react";
import { db } from "@/lib/firebase";
import { doc, updateDoc } from "firebase/firestore";
import { ShieldCheck, X, EyeOff, Eye, MicOff, Users } from "lucide-react";

interface Props {
  meetingId: string;
  aiToolsHidden: boolean;
  onClose: () => void;
  onMuteAll: () => void;
  onToggleAiTools: () => void;
}

export default function HostControlsPanel({
  meetingId, aiToolsHidden, onClose, onMuteAll, onToggleAiTools,
}: Props) {
  const [ending, setEnding] = useState(false);

  const endMeeting = async () => {
    setEnding(true);
    await updateDoc(doc(db, "meetings", meetingId), { isActive: false });
    window.location.href = "/";
  };

  return (
    <div className="flex flex-col h-full bg-card border-l border-border slide-in-right">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-primary" />
          <span className="font-semibold text-sm">Host Controls</span>
        </div>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-muted transition">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 space-y-3">
        <button
          onClick={onMuteAll}
          className="w-full flex items-center gap-3 p-3 bg-muted border border-border rounded-xl hover:bg-accent transition text-sm font-medium"
        >
          <MicOff className="w-4 h-4 text-muted-foreground" />
          Mute All Participants
        </button>

        <button
          onClick={onToggleAiTools}
          className="w-full flex items-center gap-3 p-3 bg-muted border border-border rounded-xl hover:bg-accent transition text-sm font-medium"
        >
          {aiToolsHidden
            ? <Eye className="w-4 h-4 text-green-400" />
            : <EyeOff className="w-4 h-4 text-muted-foreground" />}
          {aiToolsHidden ? "Show AI Tools to Guests" : "Hide AI Tools from Guests"}
        </button>

        <div className="pt-2 border-t border-border">
          <button
            onClick={endMeeting}
            disabled={ending}
            className="w-full flex items-center gap-3 p-3 bg-destructive/10 border border-destructive/30 rounded-xl hover:bg-destructive/20 transition text-sm font-medium text-destructive"
          >
            <Users className="w-4 h-4" />
            {ending ? "Ending…" : "End Meeting for Everyone"}
          </button>
        </div>
      </div>
    </div>
  );
}
