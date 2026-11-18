// 招待リンク（/invite#合言葉）から開く画面。初回登録とパスワード再設定の両方
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, saveSession } from '../lib/api.js'

export default function Invite() {
  const navigate = useNavigate()
  const [token] = useState(() => decodeURIComponent(window.location.hash.slice(1)))
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // 合言葉をアドレスバー・履歴に残さない
    window.history.replaceState(null, '', '/invite')
    if (!token) {
      setError('リンクが正しくありません。管理者から届いたリンクをそのまま開いてください')
      return
    }
    api('/api/works/invite/check', { method: 'POST', body: { token }, auth: false })
      .then((d) => {
        setInfo(d)
        if (d.username) setUsername(d.username)
      })
      .catch((e) => setError(e.message))
  }, [token])

  const submit = async (e) => {
    e.preventDefault()
    if (password !== password2) {
      setError('確認用のパスワードが一致しません')
      return
    }
    setBusy(true)
    setError('')
    try {
      const d = await api('/api/works/invite/accept', { method: 'POST', body: { token, username: username.trim(), password }, auth: false })
      saveSession(d)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const isReset = info?.kind === 'reset'
  return (
    <div className="works-auth">
      <form className="works-auth-card" onSubmit={submit}>
        <div className="works-brand">
          <img src="/icon.svg" alt="" />
          eWorks
        </div>
        {!info && !error && <p className="works-muted">確認しています…</p>}
        {info && (
          <>
            <p style={{ margin: 0 }}>
              <strong>{info.staff.name}</strong> さん、{isReset ? '新しいパスワードを決めてください。' : 'ログインIDとパスワードを決めて利用を始めてください。'}
            </p>
            <label className="ui-field">
              <span>ログインID</span>
              <input
                className="ui-input"
                autoComplete="username"
                autoCapitalize="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                readOnly={isReset}
                required
                pattern="[A-Za-z0-9._\-]{3,32}"
                title="半角の英数字と . _ - で 3〜32 文字"
              />
            </label>
            {!isReset && <p className="ui-note" style={{ marginTop: -8 }}>半角の英数字と . _ - で 3〜32 文字</p>}
            <label className="ui-field">
              <span>パスワード（8 文字以上）</span>
              <input className="ui-input" type="password" autoComplete="new-password" minLength={8} maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <label className="ui-field">
              <span>パスワード（確認）</span>
              <input className="ui-input" type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} required />
            </label>
          </>
        )}
        {error && <div className="works-error" role="alert">{error}</div>}
        {info && (
          <button type="submit" className="btn-primary works-btn-accent" disabled={busy}>
            {busy ? '登録中…' : isReset ? 'パスワードを変更してログイン' : '登録してログイン'}
          </button>
        )}
        <a href="/login" className="ui-note">ログイン画面へ</a>
      </form>
    </div>
  )
}
