import { useState } from "react";
import { BookOpen, X, Loader2, Copy, Check, BookMarked } from "lucide-react";
import { useAiSummarize } from "@workspace/api-client-react";
import { toast } from "sonner";

interface Props {
  transcript: string;
  isHostHidden?: boolean;
}

export default function Summarizer({ transcript, isHostHidden }: Props) {
  const [open, setOpen] = useState(false);
  const [bookMode, setBookMode] = useState(false);
  const [summary, setSummary] = useState("");
  const [copied, setCopied] = useState(false);
  const summarize = useAiSummarize();

  if (isHostHidden) return null;

  const generate = () => {
    if (!transcript.trim()) { toast.error("No transcript yet — start transcription first"); return; }
    summarize.mutate(
      { data: { transcript, roomId: "current", bookMode } },
      {
        onSuccess: (data) => setSummary(data.summary),
        onError: () => toast.error("Summarization failed"),
      }
    );
  };

  const copy = () => {
    navigator.clipboard.writeText(summary);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-muted border border-border rounded-lg text-xs font-medium hover:bg-accent transition"
        title="Open AI Summarizer"
      >
        <BookOpen className="w-3.5 h-3.5 text-primary" />
        Summary
      </button>

      {open && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-2xl w-full max-w-2xl shadow-2xl fade-in">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-primary" />
                <h2 className="font-semibold">AI Summarizer</h2>
              </div>
              <button onClick={() => setOpen(false)} className="p-1 rounded-lg hover:bg-muted transition">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Controls */}
            <div className="p-4 border-b border-border flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <div
                  onClick={() => setBookMode(!bookMode)}
                  className={`w-10 h-5 rounded-full transition-colors relative ${bookMode ? "bg-primary" : "bg-muted"}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${bookMode ? "translate-x-5" : "translate-x-0.5"}`} />
                </div>
                <BookMarked className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium">Book Mode</span>
              </label>
              <span className="text-xs text-muted-foreground">
                {bookMode ? "Structured chapters: Intro, Discussions, Conclusions, Action Items" : "Concise summary"}
              </span>
            </div>

            {/* Body */}
            <div className="p-4">
              {summary && (
                <div className="bg-muted rounded-xl p-4 mb-4 max-h-64 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap">
                  {summary}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={generate}
                  disabled={summarize.isPending}
                  className="flex-1 py-2.5 bg-primary text-primary-foreground rounded-lg font-semibold text-sm hover:opacity-90 transition disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {summarize.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  {summarize.isPending ? "Generating…" : summary ? "Regenerate" : "Generate Summary"}
                </button>
                {summary && (
                  <button
                    onClick={copy}
                    className="px-3 py-2 bg-muted border border-border rounded-lg hover:bg-accent transition flex items-center gap-1.5 text-sm"
                  >
                    {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
