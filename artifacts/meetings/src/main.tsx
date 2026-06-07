import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// In production (GitHub Pages), VITE_API_BASE_URL points to the deployed API server.
// In dev (Replit), requests go to /api via the shared proxy.
const apiBase = import.meta.env.VITE_API_BASE_URL || "";
if (apiBase) setBaseUrl(apiBase);

createRoot(document.getElementById("root")!).render(<App />);
