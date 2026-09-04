import { sendPushNotification, deserializeVapidKeys } from 'web-push-browser'
import { getAdminClient } from './supabase-admin.js'

// 購読済みの全端末へWeb Push通知を送る汎用の送信関数（2026-09-04に切り出し。
// 従来は新規タスク通知専用だったが、APIクレジット不足・利用上限到達の通知でも使うため）。
// VAPID鍵（Secrets）が未設定の間は機能オフとして何もしない（デプロイ自体は壊さない）。
export async function sendPush({ title, body, url = '/' }) {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return

  const supabase = getAdminClient()
  let subs
  try {
    const { data, error } = await supabase.from('push_subscriptions').select('id, endpoint, p256dh, auth')
    if (error) throw error
    subs = data || []
  } catch (err) {
    console.error('push: 購読一覧の取得に失敗', err)
    return
  }
  if (subs.length === 0) return

  let vapidKeys
  try {
    vapidKeys = await deserializeVapidKeys({ publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY })
  } catch (err) {
    console.error('push: VAPID鍵の読み込みに失敗', err)
    return
  }
  const email = (VAPID_SUBJECT || 'eiwa.public@gmail.com').replace(/^mailto:/, '')
  const payload = JSON.stringify({
    title: String(title || '').slice(0, 80),
    body: String(body || '').slice(0, 200),
    url,
  })

  await Promise.all(
    subs.map(async (sub) => {
      try {
        const res = await sendPushNotification(
          vapidKeys,
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          email,
          payload
        )
        // 404/410 = 購読が失効（ブラウザ側で解除・端末削除・権限取消など）。DBからも削除する。
        if (res.status === 404 || res.status === 410) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id)
        }
      } catch (err) {
        console.error('push 送信失敗:', err)
      }
    })
  )
}

// 新しいタスクが自動登録された（メール/フォーム/FAX/カレンダー取り込み）際の通知
export async function notifyNewTask({ title }) {
  await sendPush({
    title: '新しいタスクが追加されました',
    body: String(title || ''),
    url: '/',
  })
}

// APIクレジット不足・AI利用の1日あたり上限到達の通知（2026-09-04。依頼）。
// 気づかないうちに自動分類が止まっていると業務メールを取りこぼすため、
// 停止した時点で担当者の端末へ知らせる。連続送信の抑止は呼び出し側で行う
// （クレジット不足は巡回のたび、上限到達は1日に何度も起こり得るため）。
export async function notifyApiAlert({ title, body, url = '/usage' }) {
  await sendPush({ title, body, url })
}
