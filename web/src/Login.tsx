import { useState } from 'react';
import { api, type SessionInfo, type User } from './lib/api';

export function Login({ info, onLogin, error }: { info: SessionInfo; onLogin: (u: User) => void; error: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(error);

  const submit = async () => {
    setBusy(true); setErr(null);
    try { onLogin((await api<{ user: User }>('/api/auth/login', { method: 'POST', body: { email, password } })).user); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <main className="login">
      <section className="panel" aria-labelledby="login-h">
        <h1 id="login-h">NYVO</h1>
        <p className="sub">Segundo director · AINova System</p>
        {!info.ownerConfigured && <div className="notice warn" role="status">Falta configurar <code>NYVO_OWNER_EMAIL</code> en el servidor: nadie puede entrar todavía.</div>}
        {info.googleLogin && (
          <>
            <a className="btn primary" href="/api/auth/google/start?purpose=login">Entrar con Google</a>
            <div className="divider">o con correo</div>
          </>
        )}
        <form onSubmit={e => { e.preventDefault(); void submit(); }}>
          <div className="field">
            <label className="label" htmlFor="email">Correo</label>
            <input id="email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="password">Contraseña</label>
            <input id="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
          </div>
          {err && <div className="notice err" role="alert">{err}</div>}
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
        </form>
      </section>
    </main>
  );
}
