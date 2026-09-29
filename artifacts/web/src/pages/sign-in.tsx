import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { getGetSessionQueryKey, useRequestLink, useVerifyLink } from '@workspace/api-client-react';

export function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const request = useRequestLink();
  const [location, navigate] = useLocation();
  const verify = useVerifyLink();
  const client = useQueryClient();
  const attempted = useRef<string | null>(null);
  const token = new URLSearchParams(window.location.search).get('token');
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

  return <main className="app-shell">
    <h1>DojoOS</h1>
    <h2>Sign in</h2>
    {sent ? <div role="status" data-testid="status-check-inbox"><p>Check your inbox.</p><p>A sign-in link was requested for {email}.</p><button type="button" onClick={() => setSent(false)} data-testid="button-use-another-email">Use another email</button></div> :
      <form className="plain-form" onSubmit={async event => {
        event.preventDefault();
        try { await request.mutateAsync({ data: { email: email.trim() } }); setSent(true); } catch { /* error shown below */ }
      }}>
        <label htmlFor="email">Email address<input id="email" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} data-testid="input-email" /></label>
        <div><button type="submit" disabled={request.isPending} data-testid="button-request-link">{request.isPending ? 'Sending…' : 'Send sign-in link'}</button></div>
        {request.isError && <p className="error" role="alert">{request.error.message}</p>}
      </form>}
  </main>;
}