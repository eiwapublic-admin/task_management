import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import AboutModal from './AboutModal'
import { getCurrentUser, logout } from '../lib/auth'
import { reloadApp } from '../pwa/reloadApp'
import { formatBuildTime } from '../lib/version'
import { runFetch } from '../lib/api'
import { isPushSupported, getPushStatus, enablePush, disablePush } from '../lib/push'
import useStickyHeightVar from '../lib/useStickyHeightVar'

// 全画面共通のヘッダー。ロゴ・タイトル・ログインユーザー名・ハンバーガーメニューを持つ。
// 各画面はハンバーガーメニューから自由に行き来できるため、画面ごとの「×で閉じる」ボタンは不要。
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

  // 現在どのセクションを見ているか。'tasks' | 'reports' | 'equipment' の3値
  // （2026-08-04。日報機能の追加に伴う切替。2026-08-12、備品管理の追加でセクションが1つ増えた）。
  // 各セクションのパスは /reports・/equipment 配下にまとめている。window.location ではなく
  // useLocation を使い、クライアント側遷移でも確実に再評価されるようにする。
  const section = location.pathname.startsWith('/equipment')
    ? 'equipment'
    : location.pathname.startsWith('/reports')
      ? 'reports'
      : 'tasks'
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

  return (
    <>
      <header className="dashboard-header" ref={headerRef}>
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
        {/* 狭幅ではヘッダーが2行に折り返り、通常はヘッダー右側（ユーザー名・ハンバーガー）
            だけが2行目に単独で残るため space-between が効かず左寄りに表示されていた
            （2026-08-07）。同じセクション切替をモバイル専用にもう1つ用意し、2行目の
            もう一方の要素にすることで、切替＝左端／ハンバーガー側＝右端に振り分ける。
            desktop幅では常に非表示（.app-switch-mobile参照） */}
        <nav className="ui-segmented on-dark app-switch app-switch-mobile" aria-label="表示するセクション">
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
                  <button onClick={() => goTo('/')}>メイン</button>
                  <button onClick={() => goTo('/archive')}>アーカイブ</button>
                  <button className="btn-settings" onClick={() => goTo('/settings')}>設定</button>
                  <button onClick={() => goTo('/usage')}>従量課金事項</button>
                  <button onClick={() => goTo('/logs')}>処理ログ</button>
                </>
              )}
              <div className="dashboard-menu-divider" role="separator" />
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
            </div>
          </div>
        </div>
      </header>
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </>
  )
}
