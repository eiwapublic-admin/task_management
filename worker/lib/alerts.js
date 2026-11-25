// 処理ログのステータス（I/W/E）と、警告・エラーの管理者向け通知（2026-11-25〜。依頼）。
//
// ステータスは種目（log_type）とは別の列 activity_logs.level に持つ。
//   I = 情報（正常処理・操作の記録）… 既定値。今までどおり書けば I になる
//   W = 警告（期限が迫っている・在庫が少ない・上限に達した など）
//   E = エラー（処理の失敗）
// DB 変更は /mnt/project-files/logs/add_activity_log_level.sql（docs/HANDOFF.md 369番）。
//
// 通知の仕組み: W/E の行は書き込んだ側では通知せず、5分ごとの巡回（worker/index.js の
// scheduled）で「notified_at が空の W/E 行」を拾って管理者の端末へ Web Push を送り、
// notified_at を埋める。こうしておくと GitHub Actions（自動バックアップ）が psql で直接
// 書き込んだ失敗も、Worker の中で起きた失敗も、同じ経路で通知される。
// 書き込んだ側で既に通知を送っているもの（在庫警告・APIクレジット不足など）は
// notified_at を入れて書き込み、二重に鳴らさない。
//
// 費用: Web Push（ブラウザの通知）なので無料。Cloudflare Workers の外部リクエストは
// 平常時（新しい W/E が無いとき）1回の巡回あたり1回だけ増える。

import { getAdminClient } from './supabase-admin.js'
import { sendPush } from './push.js'

export const LOG_LEVELS = ['I', 'W', 'E']

// 通知先の管理者（users.id の JSON 配列）を保存する settings のキー。
// 未設定・空なら、通知を受け取る設定にしている全端末へ送る（従来の通知と同じ）。
export const ADMIN_ALERT_USERS_KEY = 'admin_alert_user_ids'
// 処理ログ画面で「確認済みにする」を押した日時（これより新しい W/E が未確認として数えられる）
export const ADMIN_ALERT_SEEN_KEY = 'admin_alerts_seen_at'

// 同じ内容の警告・エラーが続くとき（メール取得の失敗が5分ごとに出る等）、
// 前回の通知からこの時間が経つまでは鳴らさない（ログには毎回残る）
const REPEAT_SUPPRESS_HOURS = 6
// 巡回が止まっていた等で古い未通知の行が溜まっていても、2日より前のものは今さら鳴らさない
const MAX_AGE_HOURS = 48

const TYPE_LABELS = {
  fetch: 'メール取得',
  status_change: 'ステータス変更',
  backup: 'バックアップ',
  system: 'システム',
  error: 'システム',
}

export function parseUserIds(raw) {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((v) => typeof v === 'string' && v) : []
  } catch {
    return []
  }
}

// 処理ログを1行書く。level を省くと I。
// notified: true … 呼び出し側で既に通知を送った（巡回で二重に鳴らさない）
export async function writeLog(supabase, { logType, level = 'I', actor, message, detail = null, notified = false }) {
  const row = {
    log_type: logType,
    level: LOG_LEVELS.includes(level) ? level : 'I',
    actor: actor || 'システム（自動）',
    message,
    detail,
  }
  if (notified) row.notified_at = new Date().toISOString()
  const { error } = await (supabase || getAdminClient()).from('activity_logs').insert(row)
  if (error) console.error('activity_logs への書き込みに失敗:', error.message)
  return !error
}

// 同じ内容かどうかの判定用のキー（数字は日付・件数・残り日数などで毎回変わるので落とす）
function repeatKey(row) {
  return `${row.log_type}|${row.level}|${String(row.message || '').replace(/[0-9０-９]+/g, '#').slice(0, 80)}`
}

async function loadAdminUserIds(supabase) {
  const { data } = await supabase.from('settings').select('value').eq('key', ADMIN_ALERT_USERS_KEY).maybeSingle()
  return parseUserIds(data?.value)
}

// 1件または複数件の W/E から通知の文面を作る
export function buildAlertMessage(rows) {
  const errors = rows.filter((r) => r.level === 'E').length
  const warnings = rows.length - errors
  const head = rows[rows.length - 1] // いちばん新しいもの
  const label = TYPE_LABELS[head.log_type] || head.log_type
  if (rows.length === 1) {
    return {
      title: `${head.level === 'E' ? '【エラー】' : '【警告】'}${label}`,
      body: head.message,
    }
  }
  const parts = []
  if (errors) parts.push(`エラー ${errors} 件`)
  if (warnings) parts.push(`警告 ${warnings} 件`)
  return {
    title: `処理ログに${parts.join('・')}`,
    body: `最新: [${label}] ${head.message}`,
  }
}

// 5分ごとの巡回から呼ぶ。未通知の W/E があれば管理者へまとめて1回通知する。
export async function notifyPendingAlerts(supabase = getAdminClient()) {
  const since = new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000).toISOString()
  const { data: pending, error } = await supabase
    .from('activity_logs')
    .select('id, log_type, level, message, created_at')
    .neq('level', 'I')
    .is('notified_at', null)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(50)
  if (error) {
    console.error('alerts(select):', error.message)
    return { sent: 0 }
  }
  if (!pending || pending.length === 0) return { sent: 0 }

  // 直近に通知済みの同じ内容は鳴らさない
  const recentSince = new Date(Date.now() - REPEAT_SUPPRESS_HOURS * 3600 * 1000).toISOString()
  const { data: recent } = await supabase
    .from('activity_logs')
    .select('log_type, level, message')
    .neq('level', 'I')
    .gte('notified_at', recentSince)
    .limit(200)
  const seen = new Set((recent || []).map(repeatKey))
  const toNotify = []
  for (const row of pending) {
    const key = repeatKey(row)
    if (seen.has(key)) continue
    seen.add(key)
    toNotify.push(row)
  }

  let sent = 0
  if (toNotify.length > 0) {
    const userIds = await loadAdminUserIds(supabase)
    const { title, body } = buildAlertMessage(toNotify)
    sent = (await sendPush({ title, body, url: '/logs', userIds })) || 0
  }

  const { error: updErr } = await supabase
    .from('activity_logs')
    .update({ notified_at: new Date().toISOString() })
    .in(
      'id',
      pending.map((r) => r.id)
    )
  if (updErr) console.error('alerts(update):', updErr.message)
  return { sent, notified: toNotify.length, skipped: pending.length - toNotify.length }
}

// 自動バックアップが届いていないことの検知（1日1回、日本時間17時台の最初の巡回で呼ぶ）。
// GitHub Actions のスケジュールは、リポジトリに60日間動きが無いと自動で止まる・混雑で
// 実行されない日がある。失敗なら Actions 側から E が書かれるが、「そもそも動かなかった」は
// 誰も書かないので、こちらから見に行く。
export async function checkBackupFreshness(supabase = getAdminClient(), { hours = 36 } = {}) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()
  const { data, error } = await supabase
    .from('activity_logs')
    .select('id')
    .eq('log_type', 'backup')
    .eq('level', 'I')
    .gte('created_at', since)
    .limit(1)
  if (error) {
    console.error('backup-freshness:', error.message)
    return
  }
  if (data && data.length > 0) return
  await writeLog(supabase, {
    logType: 'backup',
    level: 'W',
    actor: 'システム（自動）',
    message:
      `自動バックアップの成功記録が${hours}時間以上ありません。GitHub の Actions タブ →「Daily backup」で` +
      '実行されているか、失敗していないかを確認してください。',
  })
}

// 画面用: 「確認済みにする」以降の未確認の W/E 件数
export async function countUnseenAlerts(supabase = getAdminClient()) {
  const { data: seenRow } = await supabase.from('settings').select('value').eq('key', ADMIN_ALERT_SEEN_KEY).maybeSingle()
  const seenAt = seenRow?.value || new Date(Date.now() - 7 * 86400 * 1000).toISOString()
  const { data, error } = await supabase
    .from('activity_logs')
    .select('level')
    .neq('level', 'I')
    .gt('created_at', seenAt)
    .limit(500)
  if (error) throw error
  const errors = (data || []).filter((r) => r.level === 'E').length
  return { errors, warnings: (data || []).length - errors, seenAt }
}
