// eWorks のプッシュ通知の登録（この端末）。サーバーは worker/lib/works/push.js。
// iPhone は eWorks をホーム画面に追加した場合だけ届く（iOS 16.4 以降。Safari のタブでは届かない）
import { api } from './api.js'

export function isPushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export function isIos() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true
}

function urlBase64ToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const raw = window.atob((base64Url + padding).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

// 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed'
export async function getPushStatus() {
  if (!isPushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  try {
    const reg = await navigator.serviceWorker.ready
    return (await reg.pushManager.getSubscription()) ? 'subscribed' : 'unsubscribed'
  } catch {
    return 'unsubscribed'
  }
}

export async function enablePush() {
  const { enabled, publicKey } = await api('/api/works/push/key')
  if (!enabled) throw new Error('通知の準備がまだできていません（管理者にお問い合わせください）')
  const reg = await navigator.serviceWorker.ready
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('通知が許可されませんでした。端末の設定で eWorks の通知を許可してください')
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }))
  await api('/api/works/push/subscribe', { method: 'POST', body: sub.toJSON() })
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  const endpoint = sub.endpoint
  await sub.unsubscribe()
  await api('/api/works/push/unsubscribe', { method: 'POST', body: { endpoint } })
}
