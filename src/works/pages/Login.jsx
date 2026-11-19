import { useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { isLoggedIn, login } from '../lib/api.js'

export default function Login() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(params.get('expired') ? 'ログインの有効期限が切れました。もう一度ログインしてください' : '')
  const [busy, setBusy] = useState(false)
  if (isLoggedIn()) return <Navigate to="/" replace />

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await login(username.trim(), password)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="works-auth">
      <form className="works-auth-card" onSubmit={submit}>
        <div className="works-brand">
          <img src="/icon.svg" alt="" />
          eWorks
        </div>
        <label className="ui-field">
          <span>ログインID</span>
          <input className="ui-input" autoComplete="username" autoCapitalize="off" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="ui-field">
          <span>パスワード</span>
          <input className="ui-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="works-error" role="alert">{error}</div>}
        <button type="submit" className="btn-primary works-btn-accent" disabled={busy}>
          {busy ? 'ログイン中…' : 'ログイン'}
        </button>
        <p className="ui-note">初めての方・パスワードを忘れた方は、管理者から届いたリンクを開いてください。</p>
      </form>
    </div>
  )
}
