import { QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch, Redirect } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { useSession } from "@/hooks/use-auth";
import { ToastProvider } from "@/hooks/use-toast";
import { Toaster } from "@/components/ui/toaster";

import AuthPage from "@/pages/AuthPage";
import Dashboard from "@/pages/Dashboard";
import Accounts from "@/pages/Accounts";
import Instruments from "@/pages/Instruments";
import Strategies from "@/pages/Strategies";
import BotCenter from "@/pages/BotCenter";
import Backtesting from "@/pages/Backtesting";
import TradesJournal from "@/pages/TradesJournal";
import Settings from "@/pages/Settings";
import Admin from "@/pages/Admin";
import NotFound from "@/pages/not-found";
import { AppShell } from "@/components/AppShell";

function Loading() {
  return <div className="min-h-screen grid place-items-center text-muted-foreground">Loading…</div>;
}

function Private({ children }: { children: JSX.Element }) {
  const { session, loading } = useSession();
  if (loading) return <Loading />;
  if (!session) return <Redirect to="/auth" />;
  return children;
}

function PublicOnly({ children }: { children: JSX.Element }) {
  const { session, loading } = useSession();
  if (loading) return <Loading />;
  if (session) return <Redirect to="/" />;
  return children;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Switch>
          <Route path="/auth">
            <PublicOnly>
              <AuthPage />
            </PublicOnly>
          </Route>

          <Route path="/">
            <Private>
              <AppShell>
                <Switch>
                  <Route path="/" component={Dashboard} />
                  <Route path="/accounts" component={Accounts} />
                  <Route path="/instruments" component={Instruments} />
                  <Route path="/strategies" component={Strategies} />
                  <Route path="/bot" component={BotCenter} />
                  <Route path="/backtesting" component={Backtesting} />
                  <Route path="/trades" component={TradesJournal} />
                  <Route path="/settings" component={Settings} />
                  <Route path="/admin" component={Admin} />
                  <Route component={NotFound} />
                </Switch>
              </AppShell>
            </Private>
          </Route>

          <Route component={NotFound} />
        </Switch>

        <Toaster />
      </ToastProvider>
    </QueryClientProvider>
  );
}