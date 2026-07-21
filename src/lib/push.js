import { getPushPublicKey, subscribePush, unsubscribePush } from './api'

// 新しいタスクの自動登録（メール/フォーム/FAX/カレンダー取り込み）をWeb Pushで
// 通知する機能。ブラウザのNotification許可 + PushManagerで購読し、購読情報を
// サーバー（Supabase push_subscriptions）に保存する。iPhoneはホーム画面に
// 追加したPWAからのみ通知を受け取れる（Safariタブで開いているだけでは不可）。

export function isPushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

// VAPID公開鍵（base64url）を PushManager.subscribe() が要求する Uint8Array に変換
function urlBase64ToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

// 現在の通知状態を返す: 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed'
export async function getPushStatus() {
  if (!isPushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    return sub ? 'subscribed' : 'unsubscribed'
  } catch {
    return 'unsubscribed'
  }
}

// 通知を有効化する: 権限を要求 → 購読作成 → サーバーへ登録
export async function enablePush() {
  const reg = await navigator.serviceWorker.ready
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('通知の許可が得られませんでした')
  }
  const { publicKey } = await getPushPublicKey()
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  })
  await subscribePush(sub.toJSON())
}

// 通知を無効化する: 購読解除 → サーバーから削除
export async function disablePush() {
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  const endpoint = sub.endpoint
  await sub.unsubscribe()
  await unsubscribePush(endpoint)
}
