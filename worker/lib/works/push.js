// eWorks のプッシュ通知（docs/eworks-plan.md 13-1。2026-11-24）
//
//   GET  /api/works/push/key          … VAPID の公開鍵（未設定なら enabled: false）
//   POST /api/works/push/subscribe    { endpoint, keys: { p256dh, auth } } … この端末を登録
//   POST /api/works/push/unsubscribe  { endpoint }                         … この端末の登録を外す
//
// 購読は works_push_subscriptions に利用者ごとに持つ（タスク管理の push_subscriptions は全端末へ送るため分ける）。
// VAPID の鍵はタスク管理と同じもの（シークレット VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT）。
// 鍵が未設定の間は何も送らない。iPhone は eWorks をホーム画面に追加した場合だけ届く（iOS 16.4 以降）。
import { sendPushNotification, deserializeVapidKeys } from 'web-push-browser'
import { json } from '../http.js'
import { getAdminClient } from '../supabase-admin.js'
import { requireWorks } from './auth.js'

export async function sendWorksPush(supabase, userIds, { title, body, url = '/' }) {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !userIds?.length) return 0
  try {
    const { data: subs, error } = await supabase.from('works_push_subscriptions').select('id, endpoint, p256dh, auth').in('user_id', [...new Set(userIds)])
    if (error) throw error
    if (!subs?.length) return 0
    const keys = await deserializeVapidKeys({ publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY })
    const email = (VAPID_SUBJECT || 'eiwa.public@gmail.com').replace(/^mailto:/, '')
    const payload = JSON.stringify({ title: String(title || '').slice(0, 80), body: String(body || '').slice(0, 200), url })
    let sent = 0
    await Promise.all(
      subs.map(async (sub) => {
        try {
          const res = await sendPushNotification(keys, { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, email, payload)
          if (res.status === 404 || res.status === 410) await supabase.from('works_push_subscriptions').delete().eq('id', sub.id)
          else if (res.ok) sent++
        } catch (err) {
          console.error('works push 送信失敗:', err)
        }
      })
    )
    return sent
  } catch (err) {
    console.error('works push 失敗:', err)
    return 0
  }
}

// スタッフ（works_staff.id）の本人へ送る
export async function pushToStaff(supabase, staffId, msg) {
  const { data } = await supabase.from('works_staff').select('user_id').eq('id', staffId).maybeSingle()
  if (!data?.user_id) return 0
  return sendWorksPush(supabase, [data.user_id], msg)
}

// eWorks 管理者全員へ送る
export async function pushToAdmins(supabase, msg) {
  const { data } = await supabase.from('users').select('id').eq('works_admin', true)
  return sendWorksPush(supabase, (data || []).map((u) => u.id), msg)
}

export async function handlePushKey(req) {
  const { error } = await requireWorks(req)
  if (error) return error
  const key = process.env.VAPID_PUBLIC_KEY
  return json({ enabled: !!(key && process.env.VAPID_PRIVATE_KEY), publicKey: key || null })
}

export async function handlePushSubscribe(req) {
  const { ctx, error } = await requireWorks(req)
  if (error) return error
  const b = await req.json().catch(() => ({}))
  const endpoint = String(b.endpoint || '')
  const p256dh = String(b.keys?.p256dh || '')
  const auth = String(b.keys?.auth || '')
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
    return json({ error: '通知の登録情報が正しくありません' }, 400)
  }
  const { error: e } = await getAdminClient()
    .from('works_push_subscriptions')
    .upsert({ user_id: ctx.user.id, endpoint, p256dh, auth }, { onConflict: 'endpoint' })
  if (e) throw e
  return json({ ok: true })
}

export async function handlePushUnsubscribe(req) {
  const { ctx, error } = await requireWorks(req)
  if (error) return error
  const b = await req.json().catch(() => ({}))
  if (!b.endpoint) return json({ ok: true })
  const { error: e } = await getAdminClient().from('works_push_subscriptions').delete().eq('endpoint', String(b.endpoint)).eq('user_id', ctx.user.id)
  if (e) throw e
  return json({ ok: true })
}
