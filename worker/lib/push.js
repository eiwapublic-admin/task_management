import { sendPushNotification, deserializeVapidKeys } from 'web-push-browser'
import { getAdminClient } from './supabase-admin.js'

// 新しいタスクが自動登録された（メール/フォーム/FAX/カレンダー取り込み）際に、
// 購読済みの全端末へWeb Push通知を送る。VAPID鍵（Secrets）が未設定の間は
// 機能オフとして何もしない（デプロイ自体は壊さない）。
export async function notifyNewTask({ title }) {
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
    title: '新しいタスクが追加されました',
    body: String(title || '').slice(0, 120),
    url: '/',
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
