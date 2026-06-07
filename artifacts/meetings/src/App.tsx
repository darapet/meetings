import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/lib/auth-context";
import LandingPage from "@/pages/LandingPage";
import LoginPage from "@/pages/LoginPage";
import MeetingRoom from "@/pages/MeetingRoom";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/login" component={LoginPage} />
      <Route path="/room/:roomId" component={MeetingRoom} />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <WouterRouter base={base}>
          <Router />
        </WouterRouter>
        <Toaster position="top-right" richColors />
      </AuthProvider>
    </QueryClientProvider>
  );
}
