// ビルメンのメンテナンス予定 → Google カレンダーのイベント（Phase 3。2026-09-29〜。docs/bilmen-plan.md 7-2）。
// API を叩かない純粋な部品だけをここに置く（イベントの組み立て・内容の指紋・反映状態の判定）。
// 実際の反映（Calendar API の呼び出し・DB更新）は worker/lib/bilmen.js のハンドラが行う。

// FileMaker（現行。Claris Connect 経由）が作っているイベントと同じ見た目にそろえる。
// 実物（2026-09 のイベント）は次の形だった:
//   タイトル: 電気設備巡視点検
//   説明:     電気保安定期点検・負荷設備保守(by 明和ビル管理)
//             --- created by BKB管理システム:W260901-13 at 2026/08/17 9:5x:xx
// 出所を見分けられるよう、フッターのシステム名だけ変える（3-3。並行運用中の判別用）
const SYSTEM_NAME = '栄和業務管理システム'

// JST の 'YYYY/MM/DD HH:mm:ss'
export function jstStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (type) => parts.find((p) => p.type === type)?.value || '00'
  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

function hhmm(time) {
  // DB の time は 'HH:MM:SS'。'HH:MM' に揃える
  return typeof time === 'string' && /^\d{2}:\d{2}/.test(time) ? time.slice(0, 5) : null
}

function addDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return t.toISOString().slice(0, 10)
}

function addMinutes(ymd, time, minutes) {
  const [y, m, d] = ymd.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm + minutes))
  const date = t.toISOString().slice(0, 10)
  const clock = t.toISOString().slice(11, 16)
  return { date, time: clock }
}

// イベントの「中身」（反映時刻のスタンプを除いたもの）。再反映が要るかの判定にも使う
function eventCore(s) {
  const date = s.plan_date
  const start = hhmm(s.plan_start)
  const end = hhmm(s.plan_end)
  let when
  if (!start) {
    // 時刻が無ければ終日（Google の終日イベントは終了日を「翌日」で表す）
    when = { start: { date }, end: { date: addDays(date, 1) } }
  } else {
    // 終了時刻が無い・開始より前のときは1時間枠にする
    const endAt = end && end > start ? { date, time: end } : addMinutes(date, start, 60)
    when = {
      start: { dateTime: `${date}T${start}:00+09:00`, timeZone: 'Asia/Tokyo' },
      end: { dateTime: `${endAt.date}T${endAt.time}:00+09:00`, timeZone: 'Asia/Tokyo' },
    }
  }
  const firstLine = `${s.content || ''}${s.vendor_name ? `(by ${s.vendor_name})` : ''}`
  return {
    summary: s.title || '（作業名なし）',
    location: s.place || '',
    ...when,
    firstLine,
    workNo: s.work_no || '',
  }
}

// Calendar API に送るイベント本体
export function buildBilmenEvent(schedule, stamp = jstStamp()) {
  const core = eventCore(schedule)
  // 作業IDは手入力で空のことがある（13-5）。空ならID部分を省く（7-2）
  const footer = `--- created by ${SYSTEM_NAME}${core.workNo ? `:${core.workNo}` : ''} at ${stamp}`
  return {
    summary: core.summary,
    location: core.location,
    description: [core.firstLine, footer].filter(Boolean).join('\n'),
    start: core.start,
    end: core.end,
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    // このシステムが作ったイベントだと後から判別できる印（カレンダーの画面には出ない）
    extendedProperties: { private: { eiwaSource: 'bilmen', eiwaScheduleId: String(schedule.id || '') } },
  }
}

// 反映した内容の指紋（FNV-1a 32bit）。反映時刻のスタンプは含めない。
// 実績の入力など、カレンダーに関係ない列を変えても変わらない
export function eventFingerprint(schedule) {
  const core = eventCore(schedule)
  const text = JSON.stringify([core.summary, core.location, core.start, core.end, core.firstLine, core.workNo])
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// 一覧・詳細に出す反映状態
//   undated  … 予定日付が未定（反映できない）
//   none     … 未反映
//   synced   … 反映済み（内容も一致）
//   stale    … 反映済みだが、その後に日時・作業名・場所などが変わった（要再反映）
//   canceled … 中止（カレンダーには載せない。反映済みなら中止にした時点で消している）
export function calendarState(schedule) {
  if (schedule.canceled) return 'canceled'
  if (!schedule.plan_date) return 'undated'
  if (!schedule.google_event_id) return 'none'
  return schedule.google_synced_hash === eventFingerprint(schedule) ? 'synced' : 'stale'
}

export function withCalendarState(schedule) {
  return schedule ? { ...schedule, calendar_state: calendarState(schedule) } : schedule
}
