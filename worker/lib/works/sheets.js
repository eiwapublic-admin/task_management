// 出勤簿（入力用の印刷フォーム。docs/eworks-plan.md 12章。2026-11-24 依頼元の要望）
//
//   GET  /api/works/attendance-sheet?month=YYYY-MM&staff_id=<uuid|proxy> … 出勤簿 1 人分または
//        入力方法が「管理者が代理入力」（punch_method='proxy'）の全員分のデータ（管理者）
//   POST /api/works/pdf-preview?kind=attendance  … 画面で作った PDF を一時保存し、プレビュー用の短時間トークンを返す（管理者）
//   GET  /api/works/pdf-preview?token=…&filename=… … PDF 本体（iframe から読むためトークンで認証）
//
// PDF そのものは画面で作る（タスク管理の帳票と同じ画像方式）。プレビューの仕組みはタスク管理の
// /api/report/inspection-pdf-preview と同じ（Safari は blob: の PDF を iframe に出せないため、
// 実 URL で返す。.claude/skills/multi-env-attachment-preview）。
import { json } from '../http.js'
import { getAdminClient } from '../supabase-admin.js'
import { getObject, putObject } from '../storage.js'
import { signJwt, verifyJwt } from '../jwt.js'
import { requireWorks } from './auth.js'
import { leaveSummary, loadLeaves, split } from './leave.js'
import { loadMonthShifts } from './plans.js'
import { monthRange } from './time.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export async function handleAttendanceSheet(req) {
  const { error } = await requireWorks(req, { admin: true })
  if (error) return error
  if (req.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405)
  const url = new URL(req.url)
  const month = url.searchParams.get('month')
  if (!MONTH_RE.test(String(month || ''))) return json({ error: '月が正しくありません' }, 400)
  const target = url.searchParams.get('staff_id') || 'proxy'
  if (target !== 'proxy' && !UUID_RE.test(target)) return json({ error: 'スタッフが正しくありません' }, 400)

  const supabase = getAdminClient()
  const { from, to } = monthRange(month)
  let q = supabase.from('works_staff').select('id, code, name, status, hired_on, punch_method').order('code')
  // 一括: 代理入力の在籍・休職のスタッフ（退職者と、その月より後の入社の人は除く）
  if (target === 'proxy') q = q.eq('punch_method', 'proxy').neq('status', 'retired')
  else q = q.eq('id', target)
  const { data: staffRows, error: e1 } = await q
  if (e1) throw e1
  const staffList = (staffRows || []).filter((s) => target !== 'proxy' || !s.hired_on || s.hired_on <= to)
  if (!staffList.length) {
    return json({ month, sheets: [], holidays: {}, company_holidays: {} })
  }

  const ids = staffList.map((s) => s.id)
  const [{ items, holidays, companyHolidays }, leaveRows] = await Promise.all([
    loadMonthShifts(supabase, month, { staffIds: ids }),
    loadLeaves(supabase, ids.length === 1 ? ids[0] : null),
  ])
  const leavesBy = split(leaveRows)
  const sheets = staffList.map((s) => {
    const { paid = [], special = [] } = leavesBy[s.id] || {}
    return {
      staff: { id: s.id, code: s.code, name: s.name, punch_method: s.punch_method },
      shifts: items.filter((x) => x.staff_id === s.id),
      // 有休の内訳はその月の末日時点（現行の出勤簿と同じく、月の分を「内 当月」に出す）
      leave: leaveSummary(s, paid, special, to),
      paid_days: paid.filter((d) => d >= from && d <= to),
      special_days: special.filter((d) => d >= from && d <= to),
    }
  })
  return json({ month, sheets, holidays, company_holidays: companyHolidays })
}

// ---------------------------------------------------------------------------
// PDF のプレビュー（タスク管理の帳票と同じ画面で表示・印刷するため）
// ---------------------------------------------------------------------------
const PREVIEW_TTL_SECONDS = 180
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024 // 保存先バケット report-photos の上限（10MB）に合わせる
const VALID_KINDS = new Set(['attendance'])

export async function handleWorksPdfPreview(req) {
  const url = new URL(req.url)
  const { SESSION_SECRET } = process.env
  if (req.method === 'GET') {
    const token = url.searchParams.get('token') || ''
    const claims = SESSION_SECRET && token ? await verifyJwt(token, SESSION_SECRET) : null
    if (!claims || claims.purpose !== 'works-pdf-preview' || !claims.key) return json({ error: '認証が必要です' }, 401)
    const res = await getObject(claims.key)
    if (!res.ok) return json({ error: 'PDFの取得に失敗しました' }, 404)
    const filename = (url.searchParams.get('filename') || 'eworks.pdf').slice(0, 255)
    const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
    return new Response(res.body, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'private, no-store',
        // 自オリジンの <iframe> に埋め込めるようにする（既定の DENY を上書き。worker/lib/http.js）
        'X-Frame-Options': 'SAMEORIGIN',
        'Content-Security-Policy': "frame-ancestors 'self'",
      },
    })
  }
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)

  const { ctx, error } = await requireWorks(req, { admin: true })
  if (error) return error
  const kind = url.searchParams.get('kind') || ''
  if (!VALID_KINDS.has(kind)) return json({ error: 'kind が不正です' }, 400)
  const bytes = await req.arrayBuffer()
  if (!bytes.byteLength) return json({ error: 'PDFが空です' }, 400)
  if (bytes.byteLength > MAX_PREVIEW_BYTES) return json({ error: 'PDFが大きすぎます' }, 413)
  if (!SESSION_SECRET) return json({ error: 'サーバー設定エラーが発生しました' }, 500)
  // タスク管理のプレビュー（inspection-pdf-preview/）と同じ非公開バケットに、利用者・種類ごとに 1 つだけ置く（上書き）
  const key = `works-pdf-preview/${kind}/${ctx.user.id}.pdf`
  await putObject(key, bytes, 'application/pdf', { upsert: true })
  const token = await signJwt({ purpose: 'works-pdf-preview', key }, SESSION_SECRET, PREVIEW_TTL_SECONDS)
  return json({ token })
}
