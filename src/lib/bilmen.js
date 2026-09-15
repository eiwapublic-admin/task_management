import { authFetch } from './api'

// ビルメンテナンス管理（ビルメン。Phase 1。2026-09-02〜）の API 呼び出し・共通ユーティリティ。
// 現行 FileMaker「BKB-Mgt / 作業管理」の移行。詳細は docs/bilmen-plan.md 参照。

// 管轄は2値（作業マスタ詳細ではラジオボタン。bilmen-plan 2-7）
export const BILMEN_JURISDICTIONS = ['栄和', '小泉産業']

// ---- 作業マスタ ----

export async function fetchBilmenMasters({ includeDisabled = false } = {}) {
  const qs = includeDisabled ? '?include_disabled=1' : ''
  const data = await authFetch(`/api/bilmen/masters${qs}`)
  return data.masters || []
}

export async function createBilmenMaster(payload) {
  const data = await authFetch('/api/bilmen/masters', { method: 'POST', body: JSON.stringify(payload) })
  return data.master
}

export async function updateBilmenMaster(id, patch) {
  const data = await authFetch('/api/bilmen/masters', { method: 'PATCH', body: JSON.stringify({ id, ...patch }) })
  return data.master
}

export async function deleteBilmenMaster(id) {
  await authFetch(`/api/bilmen/masters?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 表示順を10刻みに振り直す（現行の「表示順を再採番」ボタン）。{ updated } を返す
export async function renumberBilmenMasters() {
  return authFetch('/api/bilmen/masters/renumber', { method: 'POST' })
}

// ---- メンテナンス予定・実績 ----

export async function fetchBilmenSchedules({ month, months, q } = {}) {
  const params = new URLSearchParams()
  if (month) params.set('month', month)
  if (months) params.set('months', String(months))
  if (q) params.set('q', q)
  const qs = params.toString()
  const data = await authFetch(`/api/bilmen/schedules${qs ? `?${qs}` : ''}`)
  return data.schedules || []
}

export async function createBilmenSchedule(payload) {
  const data = await authFetch('/api/bilmen/schedules', { method: 'POST', body: JSON.stringify(payload) })
  return data.schedule
}

// patch に full:true を入れると詳細モーダルからの全項目保存、入れなければ
// 一覧のその場編集（送った列だけの部分更新）になる（worker/lib/bilmen.js 参照）
export async function updateBilmenSchedule(id, patch) {
  const data = await authFetch('/api/bilmen/schedules', { method: 'PATCH', body: JSON.stringify({ id, ...patch }) })
  return data.schedule
}

export async function deleteBilmenSchedule(id) {
  await authFetch(`/api/bilmen/schedules?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 自動作成の候補（対象月を実施月に含む有効なマスタ。作成済みは created:true）
export async function fetchBilmenGenerateCandidates(month) {
  const data = await authFetch(`/api/bilmen/schedules/generate?month=${encodeURIComponent(month)}`)
  return data.candidates || []
}

// 予定の自動作成。{ created, skipped } を返す
export async function generateBilmenSchedules(month, masterIds) {
  return authFetch('/api/bilmen/schedules/generate', {
    method: 'POST',
    body: JSON.stringify({ month, master_ids: masterIds }),
  })
}

// ---- 注釈と変更表記（5-4。月固有の但し書きと、差し替え版の日付）----
//
// note       … 連絡票PDFの大見出し直下に出る月固有の但し書き
// revised_on … 変更版の日付（'YYYY-MM-DD'）。掲示・報知をやり直すときに入れると、
//              掲示物のタイトル右に赤字で「（yyyy/mm/dd 変更版）」が出る（2026-09-15〜）
//
// **戻り値は文字列ではなくオブジェクト**（2026-09-15に変更日付を足した際に変えた）。
// 呼び出し側で `note` を直に文字列として扱っていないか注意すること

export const EMPTY_MONTHLY_NOTE = { note: '', revised_on: '' }

export async function fetchBilmenMonthlyNote(month) {
  const data = await authFetch(`/api/bilmen/notes?month=${encodeURIComponent(month)}`)
  return { note: data.note || '', revised_on: data.revised_on || '' }
}

// note・revised_on の両方が空なら未登録（中立色）に戻る
export async function saveBilmenMonthlyNote(month, { note, revised_on: revisedOn }) {
  const data = await authFetch('/api/bilmen/notes', {
    method: 'PUT',
    body: JSON.stringify({ target_month: month, note, revised_on: revisedOn }),
  })
  return { note: data.note || '', revised_on: data.revised_on || '' }
}

// 変更版の表記（'（2026/09/15 変更版）'）。日付が無ければ空文字。
// 掲示物のタイトル右に赤字で出す（5-4）
export function formatRevisionLabel(revisedOn) {
  if (!revisedOn) return ''
  return `（${revisedOn.replaceAll('-', '/')} 変更版）`
}

// ---- メール設定（文面・宛先） ----
// 画面（/bilmen/mail）自体を owner・備品出庫限定ロールには出さない（AppHeader・App.jsx側）が、
// API 側でも同じ判定で塞いである（worker/lib/bilmen.js の requireMailAccess）。

export async function fetchBilmenMailSettings() {
  const data = await authFetch('/api/bilmen/mail/settings')
  return data.settings
}

export async function updateBilmenMailSettings(patch) {
  const data = await authFetch('/api/bilmen/mail/settings', { method: 'PUT', body: JSON.stringify(patch) })
  return data.settings
}

// 宛先は**宛先名順**で返す（2026-09-15の依頼）。サーバー側は FileMaker 由来の
// sort_order 順で返してくるが、その並びは移行時の登録順でしかなく探しにくいため、
// ここで並べ替える。Postgres の order by より localeCompare('ja') のほうが
// 日本語の並びが自然（かなを読みの順に並べられる。漢字は読みが分からないため
// コードポイント順のままになる点は変わらない）
export async function fetchBilmenMailRecipients() {
  const data = await authFetch('/api/bilmen/mail/recipients')
  return [...(data.recipients || [])].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'))
}

export async function createBilmenMailRecipient(payload) {
  const data = await authFetch('/api/bilmen/mail/recipients', { method: 'POST', body: JSON.stringify(payload) })
  return data.recipient
}

export async function updateBilmenMailRecipient(id, patch) {
  const data = await authFetch('/api/bilmen/mail/recipients', { method: 'PATCH', body: JSON.stringify({ id, ...patch }) })
  return data.recipient
}

export async function deleteBilmenMailRecipient(id) {
  await authFetch(`/api/bilmen/mail/recipients?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 建物名（13-4。1棟のみで確定のため settings テーブルには持たせず、帳票・メールの
// 3箇所で共通して使うここに定数として置く）
export const BILMEN_BUILDING_NAME = '備後町コイズミビル'

// 掲示・案内メールの対象＝報知対象☑ かつ 予定日付あり かつ 中止でない行（3-4・8-1）。
// PDF・メール送信のどちらからも同じ条件で数えられるよう共通化する
export function notifyTargets(schedules) {
  return schedules.filter((s) => s.notify && s.plan_date && !s.canceled)
}

// 連絡票PDFの版（2026-09-14〜）。どちらも載せる内容・報知対象の絞り込みは同じで、
// 違うのは用紙の見た目とページの詰め方だけ。月の件数や留意事項の長さで使い分ける。
// 用紙コンポーネントとDOMの要素名は useBilmenNoticePdfExport.jsx 側が持つ
export const NOTICE_LAYOUTS = {
  standard: {
    label: '従来版',
    description: '1件ずつ縦に並べる、これまでの連絡票。留意事項が長い月でも収まりが良い。',
  },
  card: {
    label: 'カード版',
    description: '1件を1枚のカードにして2段組。件数が多い月でもページが増えにくい。',
  },
}

export const DEFAULT_NOTICE_LAYOUT = 'standard'

const NOTICE_LAYOUT_KEY = 'bilmen-notice-layout'

// 前回選んだ版を次回の既定にする（月次の作業なので毎回選び直させない）。
// localStorage はプライベートウィンドウ等で参照そのものが例外を投げることがあるため
// 読み書きとも握りつぶし、失敗したら既定（従来版）で動かす
export function loadNoticeLayout() {
  try {
    const saved = localStorage.getItem(NOTICE_LAYOUT_KEY)
    return saved && NOTICE_LAYOUTS[saved] ? saved : DEFAULT_NOTICE_LAYOUT
  } catch {
    return DEFAULT_NOTICE_LAYOUT
  }
}

export function saveNoticeLayout(layout) {
  try {
    localStorage.setItem(NOTICE_LAYOUT_KEY, layout)
  } catch {
    /* 保存できなくてもPDFの出力自体は続けられるので無視する */
  }
}

// メール本文・件名の変数展開（4-2）。%今月の注釈% は今月の注釈機能が未実装のため
// 対応する変数を用意していない（Phase 2 追加分）
export function expandMailVariables(text, { month, count }) {
  return (text || '')
    .replaceAll('%対象年月%', `${month.replace('-', '年')}月度`)
    .replaceAll('%建物名%', BILMEN_BUILDING_NAME)
    .replaceAll('%作業件数%', String(count))
}

// メールの宛先1件を `"宛先名" <アドレス>` の形にする（2026-09-15の依頼。メールソフト上で
// アドレスだけでなく宛先名が出るようにするため）。
// **宛先名は必ず二重引用符で囲む**: BCC はカンマ区切りのため、名前に「,」（例: '(株)A, B支店'）が
// 入っていると囲まないと宛先が分割されてしまう。RFC 5322 の quoted-string に合わせ、
// 名前の中の「\」と「"」はエスケープする。宛先名が空のときはアドレスだけを返す
export function formatMailAddress(name, email) {
  const addr = (email || '').trim()
  const label = (name || '').trim()
  if (!addr) return ''
  if (!label) return addr
  return `"${label.replace(/([\\"])/g, '\\$1')}" <${addr}>`
}

// mailto: リンクの組み立て（3-5・7-3 方式B）。宛先は BCC にまとめ、TO は空欄にする
// （共有アドレス自身が送信元になるため。src/lib/mail.js の buildReplyMailto と同じ考え方）
export function buildBilmenNoticeMailto(subject, body, recipients) {
  const bcc = (recipients || [])
    .map((r) => (typeof r === 'string' ? r : formatMailAddress(r?.name, r?.email)))
    .filter(Boolean)
    .join(',')
  const params = new URLSearchParams({ subject, body })
  if (bcc) params.set('bcc', bcc)
  return `mailto:?${params.toString().replace(/\+/g, '%20')}`
}

// ---- 表示用のユーティリティ ----

// 実施月の配列を現行表記（'1, 3, 5, 7, 9, 11'）にする。空なら「随時」
export function formatMonths(months) {
  if (!Array.isArray(months) || months.length === 0) return '随時'
  return months.join(', ')
}

// ---- 数年に1回の作業の周期（cycle_years / cycle_anchor_year。5-3-1。2026-09-15〜）----
//
// これまでは cycle_pattern（'２年に１回（奇数年）' 等のフリーテキスト）を人が読んで
// 「今年は対象か」を判断し、対象外なら自動作成してから消していた。それを機械判定に置き換える。
// 「何年に1回か（cycle_years）」と「実施年の起点（cycle_anchor_year）」の2つで表し、
// 起点から cycle_years 年ごとの年だけを実施年とみなす。
// cycle_years が無い＝毎年実施（従来どおり）。
// 判定は worker/lib/bilmen.js の同名関数と必ず揃えること（画面とAPIの両方で使う）
export function isCycleTargetYear(master, year) {
  const years = master?.cycle_years
  const anchor = master?.cycle_anchor_year
  if (!years || !anchor) return true
  // 起点より前の年でも「◯年ごと」の並びに乗っていれば対象（剰余が負にならないよう補正）
  return (((year - anchor) % years) + years) % years === 0
}

// 周期の表示（'2年に1回（2025年から）'）。毎年の作業は空文字
export function formatCycle(master) {
  const years = master?.cycle_years
  const anchor = master?.cycle_anchor_year
  if (!years || !anchor) return ''
  return `${years}年に1回（${anchor}年から）`
}

// 指定年より後で、次に実施年になる年（対象外の理由を示すために使う）
export function nextCycleYear(master, year) {
  const years = master?.cycle_years
  const anchor = master?.cycle_anchor_year
  if (!years || !anchor) return null
  let next = year + 1
  while (!isCycleTargetYear(master, next)) next += 1
  return next
}

// 予定日付を 'mm/dd' にする（一覧・PDFの年月ヘッダで年は分かるため年を出さない。修正依頼）
export function formatMonthDay(date) {
  if (!date) return ''
  return date.slice(5).replace('-', '/')
}

// time 型（'09:10:00' / '09:10'）を 'HH:MM' にそろえる。TimeInput の value に渡す形
export function toTimeValue(value) {
  return typeof value === 'string' && value.length >= 5 ? value.slice(0, 5) : ''
}

// 予定時刻の範囲表示（'09:10 〜 09:30'）。片方だけでも読めるようにする
export function formatTimeRange(start, end) {
  const s = toTimeValue(start)
  const e = toTimeValue(end)
  if (!s && !e) return ''
  return `${s || '--:--'} 〜 ${e || '--:--'}`
}

// 実績日時の表示（'2026/09/01 09:10'）。日付が無ければ空
export function formatActual(date, start) {
  if (!date) return ''
  const time = toTimeValue(start)
  return time ? `${date.replaceAll('-', '/')} ${time}` : date.replaceAll('-', '/')
}

// 「確定作業が残っている」行か（5-3）。予定日付・作業IDのどちらかが未入力なら未確定として扱い、
// 月グループの先頭に「未確定」小見出しでまとめる
export function isUnsettled(schedule) {
  return !schedule.plan_date || !schedule.work_no
}

// 「予定通り ➡」を催促表示（オレンジ）にするか（2-1）。
// 予定日を過ぎているのに実績日付が空の行だけを目立たせる。中止の行は対象外
export function isOverdueActual(schedule, today) {
  if (schedule.canceled || schedule.actual_date) return false
  return Boolean(schedule.plan_date) && schedule.plan_date < today
}
