import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { login } from '../lib/auth'
import './Login.css'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // セッション期限切れで authFetch から誘導された場合の案内。
  const expired = searchParams.get('expired') === '1'

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(username, password)
      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <img className="login-logo" src="/logo.svg" alt="栄和ロゴ" />
        <h1>栄和　タスク管理システム</h1>
        <p className="login-subtitle">ログイン</p>

        {expired && (
          <p className="login-notice" role="status">
            セッションの有効期限が切れました。再度ログインしてください。
          </p>
        )}

        <label htmlFor="username">ユーザー名</label>
        <input
          id="username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
        />

        <label htmlFor="password">パスワード</label>
        <div className="login-password-field">
          <input
            id="password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <button
            type="button"
            className="login-password-toggle"
            aria-pressed={showPassword}
            aria-label={showPassword ? 'パスワードを隠す' : 'パスワードを表示'}
            onClick={() => setShowPassword((v) => !v)}
          >
            {showPassword ? '隠す' : '表示'}
          </button>
        </div>

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" disabled={loading}>
          {loading ? 'ログイン中...' : 'ログイン'}
        </button>
      </form>
    </div>
  )
}
