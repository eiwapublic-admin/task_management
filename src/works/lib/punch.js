// 打刻の送信（docs/eworks-plan.md 6-2・6-3）。
//   ・位置情報は読み取りと並行して取りにいき、取れなければ「位置情報なし」で送る（打刻は止めない）
//   ・電波が届かないときは端末に一時保存し、電波が戻ったら自動で送る（「オフライン打刻」の印が付く）
import { api } from './api.js'

const QUEUE_KEY = 'eworks_punch_queue'

// 位置情報（取れなければ null）。timeout ミリ秒で諦める
export function getLocation(timeout = 8000) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null)
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeout + 500)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer)
        finish({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) })
      },
      () => {
        clearTimeout(timer)
        finish(null)
      },
      { enableHighAccuracy: true, timeout, maximumAge: 60_000 }
    )
  })
}

function readQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]')
  } catch {
    return []
  }
}
function writeQueue(q) {
  if (q.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(q))
  else localStorage.removeItem(QUEUE_KEY)
}
export function pendingCount() {
  return readQueue().length
}

// サーバーに届かなかった（＝電波なし）かどうか。サーバーが答えたエラーは一時保存しない
function isNetworkError(e) {
  return !e.status && (e instanceof TypeError || /fetch|network|load failed/i.test(String(e.message)))
}

// 打刻を送る。戻り値: { ok: true, result } / { queued: true } / { needsConfirm: true, message }。それ以外は例外
export async function sendPunch(qr, loc, { confirm = false } = {}) {
  const body = { ...qr, ...(loc || {}), device_at: new Date().toISOString(), confirm }
  try {
    return { ok: true, result: await api('/api/works/punch', { method: 'POST', body }) }
  } catch (e) {
    if (e.status === 409 && e.data?.needs_confirm) return { needsConfirm: true, message: e.data.message }
    if (isNetworkError(e) || !navigator.onLine) {
      writeQueue([...readQueue(), { ...body, offline: true }])
      return { queued: true }
    }
    throw e
  }
}

// 一時保存した打刻を送る。送れた件数を返す
let flushing = false
export async function flushQueue() {
  if (flushing) return 0
  flushing = true
  let sent = 0
  try {
    let q = readQueue()
    while (q.length) {
      try {
        await api('/api/works/punch', { method: 'POST', body: q[0] })
      } catch (e) {
        if (isNetworkError(e)) break
        // サーバーが受け付けなかったもの（QR の再発行など）は残しても送れないので捨てる
        console.warn('一時保存の打刻を送れませんでした:', e.message)
      }
      q = q.slice(1)
      writeQueue(q)
      sent += 1
    }
  } finally {
    flushing = false
  }
  return sent
}

export function vibrate(pattern = [80, 40, 120]) {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* 振動できない端末は何もしない */
  }
}
