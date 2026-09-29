// Google Calendar API を fetch で直接叩く軽量クライアント（追加依存なし）。
// Gmail と同じ OAuth アクセストークンを使う（スコープに calendar.readonly が必要）。

const API_BASE = 'https://www.googleapis.com/calendar/v3'

async function apiGet(accessToken, path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const text = await res.text()
    const err = new Error(`Google Calendar API エラー (${res.status}) ${path}: ${text}`)
    // スコープ不足（トークン再発行が必要）を呼び出し側で判別できるようにする
    if (res.status === 401 || res.status === 403) err.isScopeError = true
    throw err
  }
  return res.json()
}

// アクセストークンの持ち主が購読している全カレンダーを返す。
export async function listCalendars(accessToken) {
  const data = await apiGet(accessToken, '/users/me/calendarList?maxResults=250')
  return (data.items || []).map((c) => ({
    id: c.id,
    summary: c.summary || '',
    summaryOverride: c.summaryOverride || '',
  }))
}

// カレンダー名から calendarId を引く（前後空白は無視し、summaryOverride も対象）。
// 見つからなければ { id: null, available: [...カレンダー名] } を返す。
export async function resolveCalendar(accessToken, name) {
  const target = (name || '').trim()
  const cals = await listCalendars(accessToken)
  const hit = cals.find(
    (c) => c.summary.trim() === target || c.summaryOverride.trim() === target
  )
  return {
    id: hit ? hit.id : null,
    available: cals.map((c) => c.summaryOverride || c.summary).filter(Boolean),
  }
}

// JST の当日 [00:00, 翌00:00) を RFC3339（+09:00）で返す。
function todayRangeJST() {
  const ymd = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }) // YYYY-MM-DD
  const [y, m, d] = ymd.split('-').map(Number)
  const start = `${ymd}T00:00:00+09:00`
  const next = new Date(Date.UTC(y, m - 1, d))
  next.setUTCDate(next.getUTCDate() + 1)
  const nymd = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(
    next.getUTCDate()
  ).padStart(2, '0')}`
  return { timeMin: start, timeMax: `${nymd}T00:00:00+09:00` }
}

// 指定カレンダーの当日イベントを取得して整形して返す。
export async function listTodayEvents(accessToken, calendarId) {
  const { timeMin, timeMax } = todayRangeJST()
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '100',
  })
  const data = await apiGet(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events?${params}`)
  return (data.events || data.items || []).map((ev) => ({
    id: ev.id,
    title: ev.summary || '（無題の予定）',
    description: ev.description || '',
    htmlLink: ev.htmlLink || '',
    // 終日イベントは date、時間指定は dateTime
    start: ev.start?.dateTime || ev.start?.date || null,
    startDate: (ev.start?.dateTime || ev.start?.date || '').slice(0, 10) || null,
  }))
}

// ============================================================
// 書き込み（2026-09-29〜。ビルメンのカレンダー反映。docs/bilmen-plan.md 7-2）
// スコープ calendar.events が必要（2026-09-02 に付与済み。docs/google-oauth-scope-update.md）
// ============================================================

async function apiWrite(accessToken, method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  // 削除済みのイベントをもう一度消そうとしたとき（404/410）は、目的は果たせているので成功扱い
  if (method === 'DELETE' && (res.status === 404 || res.status === 410)) return null
  if (!res.ok) {
    const text = await res.text()
    const err = new Error(`Google Calendar API エラー (${res.status}): ${text.slice(0, 300)}`)
    if (res.status === 401 || res.status === 403) err.isScopeError = true
    // 反映済みのイベントを人がカレンダー側で消していた場合。呼び出し側で「作り直す」に切り替える
    if (res.status === 404 || res.status === 410) err.isGone = true
    throw err
  }
  if (res.status === 204) return null
  return res.json()
}

export async function insertEvent(accessToken, calendarId, event) {
  return apiWrite(accessToken, 'POST', `/calendars/${encodeURIComponent(calendarId)}/events`, event)
}

// 既存イベントを丸ごと書き換える（PUT ではなく PATCH。人がカレンダー側で足した参加者などは残す）
export async function patchEvent(accessToken, calendarId, eventId, event) {
  return apiWrite(
    accessToken,
    'PATCH',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    event,
  )
}

export async function deleteEvent(accessToken, calendarId, eventId) {
  return apiWrite(
    accessToken,
    'DELETE',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  )
}

// 反映先のカレンダーID。**表示名から calendarList で引く方式（resolveCalendar）は使わない**:
// 「栄和共通」はメインカレンダーの表示名で名前では引けなかった（docs/bilmen-plan.md 7-2 の注意書き）。
// settings.calendar_name に ID（'@' を含む値）がそのまま入っている前提で、それをそのまま使う。
// 名前しか入っていない場合は、読み取り側（pipeline）が解決して残したキャッシュを使い、
// それも無ければエラーにする（書き込み先を推測で決めない）
export function writableCalendarId(settings) {
  const name = (settings.calendar_name || '').trim()
  if (name.includes('@')) return name
  try {
    const cache = JSON.parse(settings.calendar_id_cache || 'null')
    if (cache && cache.name === name && cache.id) return cache.id
  } catch {
    // キャッシュが壊れていれば使わない
  }
  return null
}
