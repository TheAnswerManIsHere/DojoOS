import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { getGetSessionQueryKey, useChooseAccount, useLogin, type Account } from '@workspace/api-client-react';

const reason = (cause: unknown) => (cause as { data?: { error?: string } })?.data?.error ?? (cause instanceof Error ? cause.message : 'Could not sign in.');

/** Where to go after signing in: the page you were sent here from, when it is one of this app's own; else the library. */
function nextPath() {
  const next = new URLSearchParams(window.location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/sign-in') ? next : '/library';
}

export function SignIn() {
  const [, navigate] = useLocation();
  const client = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const login = useLogin();
  const choose = useChooseAccount();
  const signedIn = (account: Account) => { client.setQueryData(getGetSessionQueryKey(), account); navigate(nextPath(), { replace: true }); };

  // Development only: no password, just who you are (David, 2026-10-24). A published app asks for a username and password.
  if (import.meta.env.DEV) return <main className="sign-in">
    <p className="eyebrow">Bodywork Dojo · OS</p>
    <h1>Who are you?</h1>
    <p className="subtle" style={{ marginBottom: 18 }}>The development app lets you straight in.</p>
    <div className="who-picker">
      <button type="button" disabled={choose.isPending} onClick={() => choose.mutate({ data: { who: 'jared' } }, { onSuccess: signedIn })} data-testid="button-i-am-jared">I'm Jared</button>
      <button type="button" disabled={choose.isPending} onClick={() => choose.mutate({ data: { who: 'david' } }, { onSuccess: signedIn })} data-testid="button-i-am-david">I'm David</button>
    </div>
    {choose.isError && <p className="error" role="alert">Could not let you in. {reason(choose.error)}</p>}
  </main>;

  return <main className="sign-in">
    <p className="eyebrow">Bodywork Dojo · OS</p>
    <h1>Sign in</h1>
    <div className="card" style={{ marginTop: 18 }}>
    <form className="plain-form" onSubmit={event => {
      event.preventDefault();
      login.mutate({ data: { username: username.trim(), password } }, { onSuccess: signedIn });
    }}>
      <label htmlFor="username">Username<input id="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" required value={username}
        onChange={event => setUsername(event.target.value)} data-testid="input-username" /></label>
      <label htmlFor="password">Password<input id="password" type="password" autoComplete="current-password" required value={password}
        onChange={event => setPassword(event.target.value)} data-testid="input-password" /></label>
      <div><button type="submit" disabled={login.isPending} data-testid="button-sign-in">{login.isPending ? 'Signing in…' : 'Sign in'}</button></div>
      {login.isError && <p className="error" role="alert" data-testid="text-sign-in-error">{reason(login.error)}</p>}
    </form>
    </div>
  </main>;
}
