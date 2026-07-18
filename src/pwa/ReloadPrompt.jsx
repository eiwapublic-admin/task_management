import { useEffect, useRef, useState } from 'react'

// ReloadPrompt — 新しいバージョン(Service Worker)を検知したら画面上部にバナーを出し、
// ワンタップで有効化＋リロードする。素の navigator.serviceWorker のみで実装(依存追加なし)。
//
// 生成 SW(scripts/generate-sw.mjs)は fetch を横取りしないため、この仕組みは
// ナビゲーションに一切影響しない。更新検知は SW スクリプト(/sw.js)の内容が
// デプロイごとに変わる(SW_VERSION)ことで行われる。

export function ReloadPrompt({
  message = '新しいバージョンがあります',
  buttonLabel = '更新',
  accentColor = '#33604d',
  intervalMs = 60_000,
  position = 'top',
} = {}) {
  const [needRefresh, setNeedRefresh] = useState(false)
  // クリックを即座に認知できるよう「更新中…」表示に切り替えるための状態
  const [updating, setUpdating] = useState(false)
  const waitingRef = useRef(null)
  const updatingRef = useRef(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return

    // 登録時点で既に制御 SW があれば「更新」判定、無ければ初回インストール。
    const hadController = !!navigator.serviceWorker.controller
    let timer
    let reloaded = false

    const showBanner = (sw) => {
      waitingRef.current = sw
      setNeedRefresh(true)
    }

    navigator.serviceWorker
      // updateViaCache: 'none' で sw.js 自体の取得を常にHTTPキャッシュ無視にする。
      // これが無いと、ブラウザ/中間キャッシュの挙動次第で新版の sw.js を
      // 取得できず、何度デプロイしても更新バナーが出ないことがある。
      .register('/sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        // 既に待機中の新版があれば即バナー表示
        if (reg.waiting && navigator.serviceWorker.controller) {
          showBanner(reg.waiting)
        }
        // 新版のインストールを検知したらバナー表示(初回インストールは除く)
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing
          if (!nw) return
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              showBanner(reg.waiting ?? nw)
            }
          })
        })
        // 開きっぱなしの端末でも気づけるよう定期的に更新チェック
        timer = window.setInterval(() => {
          reg.update().catch(() => {})
        }, intervalMs)
      })
      .catch(() => {})

    // 新 SW が制御を取ったら 1 回だけリロード。初回インストール(clientsClaim による
    // 初掌握)では hadController=false のため誤リロードしない。
    const onControllerChange = () => {
      if (reloaded || !hadController) return
      // 手動更新中は handleUpdate 側でリロードするので、ここでは先走らない
      // （「更新中…」表示を一瞬でも見せてから遷移するため）
      if (updatingRef.current) return
      reloaded = true
      window.location.reload()
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    return () => {
      if (timer) window.clearInterval(timer)
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    }
  }, [intervalMs])

  if (!needRefresh) return null

  const vertical =
    position === 'top'
      ? { top: 0, paddingTop: 'calc(env(safe-area-inset-top) + 1rem)' }
      : { bottom: 0, paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }

  const handleUpdate = () => {
    if (updatingRef.current) return
    // クリックを即座に認知できるよう、まず「更新中…」表示に切り替える。
    updatingRef.current = true
    setUpdating(true)
    // 待機中の新 SW に SKIP_WAITING を投げる(ベストエフォート)
    try {
      waitingRef.current?.postMessage({ type: 'SKIP_WAITING' })
    } catch {
      /* 失敗してもリロードする */
    }
    // 「更新中…」を視認できる程度に見せてからリロードする（同期リロードだと無反応に見えるため）。
    // この SW はキャッシュしないので、リロード＝最新版取得。
    window.setTimeout(() => window.location.reload(), 800)
  }

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        zIndex: 2147483000,
        display: 'flex',
        justifyContent: 'center',
        padding: '0 1rem',
        ...vertical,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.15)',
          background: '#222',
          color: '#fff',
          padding: '10px 14px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          font: '14px/1.4 system-ui, sans-serif',
        }}
      >
        <span>{message}</span>
        <button
          type="button"
          onClick={handleUpdate}
          disabled={updating}
          aria-busy={updating}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            borderRadius: 8,
            border: 'none',
            // 押下直後に「更新中…」＝濃い色＋少し沈んだ見た目にして、クリックを明確に認知させる
            background: updating ? '#0f2a20' : accentColor,
            color: updating ? 'rgba(255,255,255,0.85)' : '#fff',
            padding: '10px 18px',
            minHeight: 40,
            minWidth: 96,
            justifyContent: 'center',
            fontSize: 15,
            fontWeight: 700,
            cursor: updating ? 'default' : 'pointer',
            transform: updating ? 'scale(0.96)' : 'none',
            transition: 'transform 90ms ease, background 90ms ease',
            touchAction: 'manipulation',
            WebkitTapHighlightColor: 'rgba(255,255,255,0.3)',
          }}
        >
          {updating ? '更新中…' : buttonLabel}
        </button>
        <button
          type="button"
          onClick={() => setNeedRefresh(false)}
          aria-label="閉じる"
          disabled={updating}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'rgba(255,255,255,0.6)',
            padding: 10,
            minHeight: 40,
            fontSize: 18,
            lineHeight: 1,
            cursor: updating ? 'default' : 'pointer',
            opacity: updating ? 0.4 : 1,
            touchAction: 'manipulation',
          }}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
