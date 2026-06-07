import { useEffect, useRef, useState } from "react";
import { FileText, Mic, MicOff, ChevronDown, ChevronUp } from "lucide-react";

interface Props {
  transcript: string;
  isListening: boolean;
  onToggle: () => void;
  isHostHidden?: boolean;
}

export default function NoteTaker({ transcript, isListening, onToggle, isHostHidden }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript]);

  if (isHostHidden) return null;

  return (
    <div className={`w-full max-w-2xl mx-auto transition-all duration-300 ${collapsed ? "h-10" : "h-32"}`}>
      <div className="bg-card/80 backdrop-blur-sm border border-border rounded-xl overflow-hidden h-full">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
          <div className="flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-medium">Live Note Taker</span>
            {isListening && (
              <span className="flex items-center gap-1 text-xs text-green-400">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                Live
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onToggle}
              className={`p-1 rounded-md transition ${isListening ? "text-green-400 hover:bg-green-400/10" : "text-muted-foreground hover:bg-muted"}`}
              title={isListening ? "Stop transcription" : "Start transcription"}
            >
              {isListening ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="p-1 rounded-md text-muted-foreground hover:bg-muted transition"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* Content */}
        {!collapsed && (
          <div
            ref={scrollRef}
            className="px-3 py-2 h-[calc(100%-37px)] overflow-y-auto font-mono text-xs text-foreground/80 leading-relaxed"
          >
            {transcript ? (
              <span>{transcript}<span className="cursor-blink ml-0.5 text-primary">█</span></span>
            ) : (
              <span className="text-muted-foreground italic">
                {isListening ? "Listening… speak to begin transcription" : "Click the mic to start live transcription"}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
