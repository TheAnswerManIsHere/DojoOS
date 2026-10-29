import { useEffect, type ReactNode } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { getGetSessionQueryKey, getListQuestionsQueryKey, useGetSession, useListQuestions, useLogout } from '@workspace/api-client-react';
import { QuestionRail } from '@/components/question-rail';
import { Library } from '@/pages/library';
import { FeedbackPage } from '@/pages/feedback';
import { SignIn } from '@/pages/sign-in';
import { LoggingViewer } from '@/prototypes/logging-viewer/logging-viewer';
import { LessonTimeline } from '@/prototypes/lesson-timeline/lesson-timeline';

/** A sign-in that runs out while a page is open: the next request to fail for it goes to the sign-in page, which brings
 * you back here afterwards (David, 2026-10-28). The session check itself is left to Routes. */
function toSignInOn401(error: unknown, key?: readonly unknown[]) {
  if ((error as { status?: number })?.status !== 401) return;
  if (key && JSON.stringify(key) === JSON.stringify(getGetSessionQueryKey())) return;
  if (window.location.pathname === '/sign-in') return;
  window.location.assign(`/sign-in?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  queryCache: new QueryCache({ onError: (error, query) => toSignInOn401(error, query.queryKey) }),
  mutationCache: new MutationCache({ onError: (error) => toSignInOn401(error) }),
});

function Redirect({ to }: { to: string }) {
  const [, navigate] = useLocation();
  useEffect(() => { navigate(to, { replace: true }); }, [navigate, to]);
  return <p role="status">Redirecting…</p>;
}

/** The brand's emblem, drawn as a stand-in until the real artwork arrives (David, 2026-10-27: "Mock it for now"). */
function Emblem() {
  return <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true" fill="none" stroke="#ac8c40" strokeWidth="1.4">
    <circle cx="17" cy="17" r="15.5" strokeDasharray="1.2 2.2" /><circle cx="17" cy="17" r="12.5" />
    <path d="M17 6.5 L25 26 H9 Z" /><circle cx="17" cy="20" r="2.2" /><circle cx="17" cy="15.6" r="1.6" />
  </svg>;
}

function AuthenticatedShell({ children, feature, page, email, tier }: {
  children: ReactNode; feature: string; page: string; email: string; tier: string;
}) {
  const [location, navigate] = useLocation();
  const client = useQueryClient();
  const logout = useLogout();
  const questions = useListQuestions({ feature }, { query: { queryKey: getListQuestionsQueryKey({ feature }) } });
  const hasRail = !!questions.data?.length;
  const name = tier === 'operator' ? 'Jared' : 'David';
  const here = (path: string) => (location === path ? 'page' : undefined);
  return <div className="app-shell">
    <header className="app-header">
      <div className="app-header-inner">
        <Link href="/library" className="wordmark" aria-label="Bodywork Dojo OS, the library">
          <span className="wordmark-word light">BODYWORK</span><Emblem /><span className="wordmark-word">DOJO</span><span className="wordmark-os">OS</span>
        </Link>
        <nav className="app-nav" aria-label="Main navigation">
          <Link href="/library" aria-current={here('/library')} data-testid="link-library">Library</Link>
          <Link href="/feedback" aria-current={here('/feedback')} data-testid="link-feedback">Feedback</Link>
          {/* The address stays in the page for the journeys and screen readers; on screen it is just the person. */}
          <span className="app-who" data-testid="text-account-email">{name}<span className="sr-only"> · {email}</span></span>
          <button type="button" disabled={logout.isPending} onClick={async () => {
            try {
              await logout.mutateAsync();
              client.clear();
              navigate('/sign-in', { replace: true });
            } catch { /* error shown below */ }
          }} data-testid="button-sign-out">{import.meta.env.DEV ? 'Switch person' : 'Sign out'}</button>
        </nav>
      </div>
    </header>
    {logout.isError && <p role="alert" className="error">Could not sign out. {logout.error.message}</p>}
    <div className={`app-main${hasRail ? ' with-rail' : ''}`}>
      <main className="app-content">{children}</main>
      {hasRail && <QuestionRail feature={feature} page={page} />}
    </div>
  </div>;
}

function Routes() {
  const [location] = useLocation();
  const session = useGetSession({ query: { queryKey: getGetSessionQueryKey(), retry: false } });
  const isAuthPath = location === '/sign-in' || location === '/auth/callback' || location === '/sign-in/callback' || location === '/callback';
  const hasToken = !!new URLSearchParams(window.location.search).get('token');
  if (session.isLoading) return <main className="app-main"><p role="status">Checking session…</p></main>;
  if (session.isError && session.error.status !== 401 && session.error.status !== 403) {
    return <main className="app-main"><h1>DojoOS</h1><p className="error" role="alert">Could not check your session. {session.error.message}</p><button type="button" onClick={() => session.refetch()} data-testid="button-retry-session">Retry</button></main>;
  }
  if (!session.data) {
    if (!isAuthPath) return <Redirect to={`/sign-in?next=${encodeURIComponent(location)}`} />;
    return <SignIn />;
  }
  if (isAuthPath && !hasToken) return <Redirect to="/library" />;
  if (isAuthPath && hasToken) return <SignIn />;
  const account = session.data;
  return <Switch>
    <Route path="/"><Redirect to="/library" /></Route>
    <Route path="/library"><AuthenticatedShell feature="library" page="/library" email={account.email} tier={account.tier}><Library accountId={account.id} /></AuthenticatedShell></Route>
    <Route path="/shoots/:id/lesson">{(params: { id: string }) => <AuthenticatedShell feature="lesson-timeline" page={`/shoots/${params.id}/lesson`} email={account.email} tier={account.tier}><LessonTimeline shootId={params.id} /></AuthenticatedShell>}</Route>
    <Route path="/sources/:id/log">{(params: { id: string }) => <AuthenticatedShell feature="logging-viewer" page={`/sources/${params.id}/log`} email={account.email} tier={account.tier}><LoggingViewer sourceId={params.id} /></AuthenticatedShell>}</Route>
    <Route path="/feedback"><AuthenticatedShell feature="feedback" page="/feedback" email={account.email} tier={account.tier}><FeedbackPage /></AuthenticatedShell></Route>
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