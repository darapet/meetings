import { useLocation } from "wouter";
import { AlertCircle } from "lucide-react";

export default function NotFound() {
  const [, setLocation] = useLocation();
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background">
      <AlertCircle className="w-12 h-12 text-destructive" />
      <h1 className="text-3xl font-bold">404 — Not Found</h1>
      <p className="text-muted-foreground">This page doesn't exist.</p>
      <button
        onClick={() => setLocation("/")}
        className="px-5 py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:opacity-90 transition"
      >
        Go Home
      </button>
    </div>
  );
}
