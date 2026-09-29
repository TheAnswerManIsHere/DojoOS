import { useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { getGetSessionQueryKey, useGetSession, useLogout } from '@workspace/api-client-react';
import { QuestionRail } from '@/components/question-rail';
import { Library } from '@/pages/library';
import { FeedbackPage } from '@/pages/feedback';
import { SignIn } from '@/pages/sign-in';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

function Redirect({ to }: { to: string }) {
  const [, navigate] = useLocation();
  useEffect(() => { navigate(to, { replace: true }); }, [navigate, to]);
  return <p role="status">Redirecting…</p>;
}

function AuthenticatedShell({ children, feature, page, email, tier }: {
  children: ReactNode; feature: string; page: string; email: string; tier: string;
}) {
  const [, navigate] = useLocation();
  const client = useQueryClient();
  const logout = useLogout();
  return <div className="app-shell">
    <header className="app-header">
      <strong>DojoOS</strong>
      <nav className="app-nav" aria-label="Main navigation">
        <Link href="/library" data-testid="link-library">Library</Link>
        {tier === 'operator' && <Link href="/feedback" data-testid="link-feedback">Feedback</Link>}
        <span className="subtle" data-testid="text-account-email">{email}</span>
        <button type="button" disabled={logout.isPending} onClick={async () => {
          try {
            await logout.mutateAsync();
            client.clear();
            navigate('/sign-in', { replace: true });
          } catch { /* error shown below */ }
        }} data-testid="button-sign-out">Sign out</button>
      </nav>
    </header>
    {logout.isError && <p role="alert" className="error">Could not sign out. {logout.error.message}</p>}
    <div className="app-main">
      <main className="app-content">{children}</main>
      {tier === 'tester' && <QuestionRail feature={feature} page={page} />}
    </div>
  </div>;
}

function Routes() {
  const [location] = useLocation();
  const session = useGetSession({ query: { queryKey: getGetSessionQueryKey(), retry: false } });
  const isAuthPath = location === '/sign-in' || location === '/auth/callback' || location === '/sign-in/callback' || location === '/callback';
  const hasToken = !!new URLSearchParams(window.location.search).get('token');
  if (session.isLoading) return <main className="app-shell"><p role="status">Checking session…</p></main>;
  if (session.isError && session.error.status !== 401 && session.error.status !== 403) {
    return <main className="app-shell"><h1>DojoOS</h1><p className="error" role="alert">Could not check your session. {session.error.message}</p><button type="button" onClick={() => session.refetch()} data-testid="button-retry-session">Retry</button></main>;
  }
  if (!session.data) {
    if (!isAuthPath) return <Redirect to="/sign-in" />;
    return <SignIn />;
  }
  if (isAuthPath && !hasToken) return <Redirect to="/library" />;
  if (isAuthPath && hasToken) return <SignIn />;
  const account = session.data;
  return <Switch>
    <Route path="/"><Redirect to="/library" /></Route>
    <Route path="/library"><AuthenticatedShell feature="library" page="/library" email={account.email} tier={account.tier}><Library accountId={account.id} /></AuthenticatedShell></Route>
    <Route path="/feedback">{account.tier === 'operator' ? <AuthenticatedShell feature="feedback" page="/feedback" email={account.email} tier={account.tier}><FeedbackPage /></AuthenticatedShell> : <Redirect to="/library" />}</Route>
    <Route><AuthenticatedShell feature="not-found" page={location} email={account.email} tier={account.tier}><h1>Page not found</h1><p><Link href="/library" data-testid="link-return-library">Return to library</Link></p></AuthenticatedShell></Route>
  </Switch>;
}

function App() {
  return <QueryClientProvider client={queryClient}>
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <Routes />
    </WouterRouter>
  </QueryClientProvider>;
}

export default App;