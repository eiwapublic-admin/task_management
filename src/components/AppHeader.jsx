import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import AboutModal from './AboutModal'
import { getCurrentUser, logout } from '../lib/auth'
import { reloadApp } from '../pwa/reloadApp'
import { formatBuildTime } from '../lib/version'
import { runFetch } from '../lib/api'
import { isPushSupported, getPushStatus, enablePush, disablePush } from '../lib/push'
import useStickyHeightVar from '../lib/useStickyHeightVar'

// アプリヘッダ（画面構成の1層目）。全画面で共通。
//
//   左: アプリアイコン（ロゴ）＋ セクション切替（タスク／日報／備品）
//   右: ログインユーザー名（広い画面のみ）＋ ハンバーガーメニュー
//
// 2026-08-12 の画面構成見直しで「栄和　タスク管理システム」の文字表示をやめた。
// アプリ名は常時見えている必要が薄く、その幅をセクション切替に回した方が、どの機能を
// 見ているかが一目で分かる。合わせて、狭幅用に複製していたセクション切替
// （.app-switch-mobile）と grid-template-areas での行割り当ても不要になったので撤去した
// （タイトルが無くなり、1行に収まるようになったため）。
//
// ロゴの役割も変えた（設計書 4-3）:
//   - 各機能画面 … タップでダッシュボード（ポータル）へ移動
//   - ダッシュボード … タップでアプリの更新・再表示（従来の最新化と同じ挙動）
export default function AppHeader() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [fetching, setFetching] = useState(false)
  // 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed' | 'loading'
  const [pushStatus, setPushStatus] = useState('loading')
  const menuRef = useRef(null)
  const navigate = useNavigate()
  const location = useLocation()
  const user = getCurrentUser()
  // 各画面で2段目・3段目のヘッダーを重ねてスタック固定できるよう、実際の高さを
  // CSS変数 --app-header-h として反映する（詳しくは useStickyHeightVar.js）
  const headerRef = useStickyHeightVar('--app-header-h')

  useEffect(() => {
    if (!isPushSupported()) {
      setPushStatus('unsupported')
      return
    }
    getPushStatus().then(setPushStatus)
  }, [])

  // 通知のオン/オフを切り替える（新しいタスクが自動登録された際のWeb Push通知）。
  async function handleTogglePush() {
    if (pushStatus === 'subscribed') {
      try {
        await disablePush()
        setPushStatus('unsubscribed')
      } catch (err) {
        window.alert(`通知の解除に失敗しました: ${err.message}`)
      }
      return
    }
    try {
      await enablePush()
      setPushStatus('subscribed')
    } catch (err) {
      setPushStatus(await getPushStatus())
      window.alert(`通知を有効にできませんでした: ${err.message}`)
    }
  }

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
  // 完了後は画面を再読み込みしてカンバンへ戻り、最新の取得結果を反映する
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

  // 現在どのセクションを見ているか。'portal' | 'tasks' | 'reports' | 'equipment'
  // （2026-08-04。日報機能の追加に伴う切替。2026-08-12、備品管理とダッシュボードが増えた）。
  // 各セクションのパスは /reports・/equipment 配下にまとめている。window.location ではなく
  // useLocation を使い、クライアント側遷移でも確実に再評価されるようにする。
  const section = location.pathname.startsWith('/portal')
    ? 'portal'
    : location.pathname.startsWith('/equipment')
      ? 'equipment'
      : location.pathname.startsWith('/reports')
        ? 'reports'
        : 'tasks'
  const inPortal = section === 'portal'
  const inReports = section === 'reports'
  const inEquipment = section === 'equipment'
  // owner（小泉産業様）は日報・備品（閲覧のみ）。タスク管理のメニュー・切替は出さない
  const isOwner = user?.role === 'owner'
  // セクション切替の選択肢。owner には「タスク」を出さない（2026-08-12、備品セクションの追加で
  // owner にもセクション切替そのものが必要になった。従来は日報1本だったため切替UI自体が無かった）
  const sections = [
    ...(isOwner ? [] : [{ key: 'tasks', label: 'タスク', path: '/' }]),
    { key: 'reports', label: '日報', path: '/reports' },
    { key: 'equipment', label: '備品', path: '/equipment' },
  ]

  // ロゴは「ダッシュボードへ戻る」ボタン。ダッシュボードにいるときだけ最新化を担う
  function handleLogoClick() {
    if (inPortal) {
      reloadApp({ to: '/portal' })
      return
    }
    navigate('/portal')
  }

  return (
    <>
      <header className="app-header" ref={headerRef}>
        <div className="app-header-left">
          <button
            type="button"
            className="app-logo-button"
            onClick={handleLogoClick}
            aria-label={inPortal ? '最新の状態に更新' : 'ダッシュボードへ移動'}
            title={inPortal ? 'タップで最新の状態に更新' : 'ダッシュボードへ移動'}
            style={{ touchAction: 'manipulation' }}
          >
            <img className="app-logo" src="/logo.svg" alt="栄和ロゴ" />
          </button>
          <nav className="ui-segmented on-dark app-switch" aria-label="表示するセクション">
            {sections.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`ui-segmented-btn${section === s.key ? ' is-active' : ''}`}
                aria-current={section === s.key ? 'page' : undefined}
                onClick={() => goTo(s.path)}
              >
                {s.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="app-header-right">
          {user?.display_name && <span className="app-header-user">{user.display_name} さん</span>}
          <div className="app-menu" ref={menuRef}>
            <button
              type="button"
              className="app-menu-toggle"
              aria-label="メニュー"
              aria-haspopup="true"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <span className="app-menu-icon" aria-hidden="true"></span>
            </button>
            <div className={`app-menu-panel${menuOpen ? ' is-open' : ''}`}>
              {/* ユーザー名はヘッダーでは広い画面にしか出さない（狭幅では場所を取るため）。
                  誰でログインしているかはここで必ず確認できるようにしておく */}
              {user?.display_name && (
                <p className="app-menu-user">{user.display_name} さん</p>
              )}
              <button onClick={() => goTo('/portal')}>ダッシュボード</button>
              <div className="app-menu-divider" role="separator" />
              {inEquipment ? (
                <>
                  {/* 備品セクション（2026-08-12〜）。owner には閲覧できるものだけを出す
                      （マスタ編集は出さない。docs/equipment-plan.md 5-0） */}
                  <button onClick={() => goTo('/equipment')}>在庫一覧</button>
                  {!isOwner && <button onClick={() => goTo('/equipment/items')}>備品マスタ</button>}
                  {!isOwner && <button onClick={() => goTo('/usage')}>従量課金事項</button>}
                </>
              ) : inReports || isOwner ? (
                <>
                  {/* 自主検査表は日報一覧画面の見える位置に移動済み（2026-08-05）。
                      ここには日報セクションへ戻る導線だけを残す */}
                  <button onClick={() => goTo('/reports')}>日報一覧</button>
                  {/* 従量課金事項は日報表示中でも確認できるようにする（2026-08-05）。オーナーは対象外 */}
                  {!isOwner && <button onClick={() => goTo('/usage')}>従量課金事項</button>}
                  {/* 定型文の設定（旧・日報一覧ツールバーの歯車ボタン）をここへ移動
                      （2026-08-10。iPhone幅でツールバーのボタンが1行に収まるようにするため） */}
                  {!isOwner && <button onClick={() => goTo('/reports/templates')}>作業定型文の設定</button>}
                </>
              ) : (
                <>
                  <button onClick={() => goTo('/')}>カンバン</button>
                  <button onClick={() => goTo('/archive')}>アーカイブ</button>
                  <button className="btn-settings" onClick={() => goTo('/settings')}>設定</button>
                  <button onClick={() => goTo('/usage')}>従量課金事項</button>
                  <button onClick={() => goTo('/logs')}>処理ログ</button>
                </>
              )}
              <div className="app-menu-divider" role="separator" />
              {!inReports && !inEquipment && !isOwner && (
                <button onClick={handleRunFetch} disabled={fetching}>
                  {fetching ? '取得中…' : '今すぐ取得'}
                </button>
              )}
              {pushStatus !== 'unsupported' && (
                <button
                  onClick={handleTogglePush}
                  disabled={pushStatus === 'loading' || pushStatus === 'denied'}
                  title={
                    pushStatus === 'denied'
                      ? 'ブラウザの設定で通知がブロックされています'
                      : undefined
                  }
                >
                  {pushStatus === 'subscribed' && '🔔 通知をオフに'}
                  {pushStatus === 'unsubscribed' && '通知をオンにする'}
                  {pushStatus === 'denied' && '通知がブロックされています'}
                  {pushStatus === 'loading' && '通知'}
                </button>
              )}
              <button
                onClick={() => {
                  setMenuOpen(false)
                  setAboutOpen(true)
                }}
              >
                当システムについて
              </button>
              <button className="btn-logout" onClick={handleLogout}>ログアウト</button>
              {/* ビルド時刻。ヘッダーからここへ移した（2026-08-12）。端末が最新の
                  デプロイを取得できているかの確認用で、常時見えている必要はない */}
              <p className="app-menu-version">ver.{formatBuildTime()}</p>
            </div>
          </div>
        </div>
      </header>
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </>
  )
}
