import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { getGetSessionQueryKey, useChooseAccount, useRequestLink, useVerifyLink } from '@workspace/api-client-react';

export function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [magicLink, setMagicLink] = useState<string>();
  const request = useRequestLink();
  const [location, navigate] = useLocation();
  const verify = useVerifyLink();
  const client = useQueryClient();
  const attempted = useRef<string | null>(null);
  const token = new URLSearchParams(window.location.search).get('token');
  const choose = useChooseAccount();
  const pick = (who: 'jared' | 'david') => choose.mutate({ data: { who } }, {
    onSuccess: account => { client.setQueryData(getGetSessionQueryKey(), account); navigate('/library', { replace: true }); },
  });
  useEffect(() => {
    if (!token || attempted.current === token) return;
    attempted.current = token;
    verify.mutate({ data: { token } }, {
      onSuccess: account => { client.setQueryData(getGetSessionQueryKey(), account); window.history.replaceState({}, '', location); navigate('/library', { replace: true }); },
    });
  }, [token, verify.mutate, client, navigate, location]);

  if (token) return <main className="app-shell">
    <h1>DojoOS</h1>
    {verify.isPending && <p role="status">Signing in…</p>}
    {verify.isError && <><p role="alert" className="error">This link could not be verified. {verify.error?.message}</p><button type="button" onClick={() => { window.history.replaceState({}, '', '/sign-in'); navigate('/sign-in'); }} data-testid="button-back-sign-in">Request another link</button></>}
  </main>;

  // Prototype phase, development only: no sign-in, just who you are (David, 2026-10-24). A published app keeps the link.
  if (import.meta.env.DEV) return <main className="app-shell">
    <h1>DojoOS</h1>
    <h2>Who are you?</h2>
    <div className="who-picker">
      <button type="button" disabled={choose.isPending} onClick={() => pick('jared')} data-testid="button-i-am-jared">I'm Jared</button>
      <button type="button" disabled={choose.isPending} onClick={() => pick('david')} data-testid="button-i-am-david">I'm David</button>
    </div>
    {choose.isError && <p className="error" role="alert">Could not let you in. {choose.error?.message}</p>}
  </main>;

  return <main className="app-shell">
    <h1>DojoOS</h1>
    <h2>Sign in</h2>
    {sent ? <div role="status" data-testid="status-check-inbox"><p>{magicLink ? <a href={magicLink}>Sign in to DojoOS</a> : 'Check your inbox.'}</p>{magicLink && <p>{magicLink}</p>}<p>A sign-in link was requested for {email}.</p><button type="button" onClick={() => { setSent(false); setMagicLink(undefined); }} data-testid="button-use-another-email">Use another email</button></div> :
      <form className="plain-form" onSubmit={async event => {
        event.preventDefault();
        try { const response = await request.mutateAsync({ data: { email: email.trim() } }); setMagicLink(import.meta.env.DEV ? response.magicLink : undefined); setSent(true); } catch { /* error shown below */ }
      }}>
        <label htmlFor="email">Email address<input id="email" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} data-testid="input-email" /></label>
        <div><button type="submit" disabled={request.isPending} data-testid="button-request-link">{request.isPending ? 'Sending…' : 'Send sign-in link'}</button></div>
        {request.isError && <p className="error" role="alert">{request.error.message}</p>}
      </form>}
  </main>;
}