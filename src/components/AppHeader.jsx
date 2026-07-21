import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AboutModal from './AboutModal'
import { getCurrentUser, logout } from '../lib/auth'
import { reloadApp } from '../pwa/reloadApp'
import { formatBuildTime } from '../lib/version'
import { runFetch } from '../lib/api'

// 全画面共通のヘッダー。ロゴ・タイトル・ログインユーザー名・ハンバーガーメニューを持つ。
// 各画面はハンバーガーメニューから自由に行き来できるため、画面ごとの「×で閉じる」ボタンは不要。
export default function AppHeader() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [fetching, setFetching] = useState(false)
  const menuRef = useRef(null)
  const navigate = useNavigate()
  const user = getCurrentUser()

  // メニューを開いている間は、外側クリック / Escape で閉じる
  useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  function goTo(path) {
    setMenuOpen(false)
    navigate(path)
  }

  function handleLogout() {
    logout()
    navigate('/login')
  }

  // メニューの「今すぐ取得」。どの画面からでも実行できるようにするため、
  // 完了後は画面を再読み込みしてダッシュボードへ戻り、最新の取得結果を反映する
  // （個別画面のstateに依存しないよう、あえてフルリロードにしている）。
  async function handleRunFetch() {
    if (fetching) return
    setFetching(true)
    try {
      await runFetch()
    } catch (err) {
      window.alert(`メール取得に失敗しました: ${err.message}`)
    } finally {
      setMenuOpen(false)
      window.location.assign('/')
    }
  }

  return (
    <>
      <header className="dashboard-header">
        <div className="dashboard-header-left">
          <button
            type="button"
            className="dashboard-logo-button"
            onClick={() => reloadApp()}
            aria-label="最新の状態に更新"
            title="タップで最新の状態に更新"
            style={{ touchAction: 'manipulation' }}
          >
            <img className="dashboard-logo" src="/logo.svg" alt="栄和ロゴ" />
          </button>
          <div className="dashboard-title-wrap">
            <h1>栄和　タスク管理システム</h1>
            <span className="dashboard-version">ver.{formatBuildTime()}</span>
          </div>
        </div>
        <div className="dashboard-header-right">
          {user?.display_name && <span className="dashboard-user">{user.display_name} さん</span>}
          <div className="dashboard-menu" ref={menuRef}>
            <button
              type="button"
              className="dashboard-menu-toggle"
              aria-label="メニュー"
              aria-haspopup="true"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <span className="dashboard-menu-icon" aria-hidden="true"></span>
            </button>
            <div className={`dashboard-actions${menuOpen ? ' is-open' : ''}`}>
              <button onClick={() => goTo('/')}>メイン</button>
              <button onClick={() => goTo('/archive')}>アーカイブ</button>
              <button className="btn-settings" onClick={() => goTo('/settings')}>設定</button>
              <button onClick={() => goTo('/usage')}>従量課金事項</button>
              <button onClick={() => goTo('/logs')}>処理ログ</button>
              <div className="dashboard-menu-divider" role="separator" />
              <button onClick={handleRunFetch} disabled={fetching}>
                {fetching ? '取得中…' : '今すぐ取得'}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false)
                  setAboutOpen(true)
                }}
              >
                このシステムについて
              </button>
              <button className="btn-logout" onClick={handleLogout}>ログアウト</button>
            </div>
          </div>
        </div>
      </header>
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </>
  )
}
