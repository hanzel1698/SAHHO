import { useState } from 'react';
import { Database } from 'lucide-react';
import { signIn } from '../cloud';
import { ErrorLine, useAsync } from './common';

export function SignIn() {
  const { busy, error, run } = useAsync();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <div className="loading">
      <form className="panel signin" onSubmit={e => { e.preventDefault(); void run(() => signIn(email.trim(), password)); }}>
        <h2><Database size={20} /> SAHHO contributions</h2>
        <p>Sign in with your treasurer account.</p>
        <label>Email<input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <ErrorLine error={error} />
      </form>
    </div>
  );
}
