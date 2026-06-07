import {
  Mic, MicOff, Video, VideoOff, Monitor, MonitorOff,
  PhoneOff, MessageCircle, Users, Hand, ShieldCheck,
} from "lucide-react";

interface Props {
  micEnabled: boolean;
  cameraEnabled: boolean;
  screenSharing: boolean;
  chatOpen: boolean;
  participantsOpen: boolean;
  isHost: boolean;
  handRaised: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreen: () => void;
  onToggleChat: () => void;
  onToggleParticipants: () => void;
  onRaiseHand: () => void;
  onEndCall: () => void;
  onHostControls?: () => void;
  forcedMute?: boolean;
}

export default function ControlBar({
  micEnabled, cameraEnabled, screenSharing,
  chatOpen, participantsOpen, isHost,
  handRaised, forcedMute,
  onToggleMic, onToggleCamera, onToggleScreen,
  onToggleChat, onToggleParticipants,
  onRaiseHand, onEndCall, onHostControls,
}: Props) {

  const btn = (active: boolean, danger = false) =>
    `flex flex-col items-center gap-1 p-3 rounded-xl transition-all ${
      danger
        ? "bg-destructive text-destructive-foreground hover:opacity-90"
        : active
        ? "bg-primary/20 text-primary border border-primary/30"
        : "bg-card border border-border text-foreground hover:bg-muted"
    }`;

  const label = "text-[10px] font-medium hidden sm:block";

  return (
    <div className="flex items-center justify-center gap-2 px-4 py-3 bg-background/80 backdrop-blur-sm border-t border-border">
      {/* Mic */}
      <button onClick={onToggleMic} disabled={forcedMute} className={btn(micEnabled)} title="Toggle mic">
        {micEnabled && !forcedMute ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5 text-destructive" />}
        <span className={label}>{forcedMute ? "Muted" : micEnabled ? "Mute" : "Unmute"}</span>
      </button>

      {/* Camera */}
      <button onClick={onToggleCamera} className={btn(cameraEnabled)} title="Toggle camera">
        {cameraEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5 text-destructive" />}
        <span className={label}>{cameraEnabled ? "Stop Video" : "Start Video"}</span>
      </button>

      {/* Screen Share */}
      <button onClick={onToggleScreen} className={btn(screenSharing)} title="Share screen">
        {screenSharing ? <MonitorOff className="w-5 h-5" /> : <Monitor className="w-5 h-5" />}
        <span className={label}>{screenSharing ? "Stop Share" : "Share"}</span>
      </button>

      {/* Raise Hand */}
      <button onClick={onRaiseHand} className={btn(handRaised)} title="Raise hand">
        <Hand className="w-5 h-5" />
        <span className={label}>{handRaised ? "Lower" : "Hand"}</span>
      </button>

      {/* Chat */}
      <button onClick={onToggleChat} className={btn(chatOpen)} title="Chat">
        <MessageCircle className="w-5 h-5" />
        <span className={label}>Chat</span>
      </button>

      {/* Participants */}
      <button onClick={onToggleParticipants} className={btn(participantsOpen)} title="Participants">
        <Users className="w-5 h-5" />
        <span className={label}>People</span>
      </button>

      {/* Host Controls */}
      {isHost && onHostControls && (
        <button onClick={onHostControls} className={btn(false)} title="Host controls">
          <ShieldCheck className="w-5 h-5 text-primary" />
          <span className={label}>Host</span>
        </button>
      )}

      {/* End Call */}
      <button onClick={onEndCall} className={btn(false, true)} title="Leave meeting">
        <PhoneOff className="w-5 h-5" />
        <span className={label}>Leave</span>
      </button>
    </div>
  );
}
