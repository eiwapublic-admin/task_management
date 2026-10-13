// 業務マニュアル（日常業務の手引書）の API ハンドラ（2026-10-13〜）。
// 依頼元の「対応マニュアル.xlsx」の「対応マニュアル」「定例作業」シートと、定例作業から参照される
// 手順のシートを取り込んだもの（supabase/schema.sql の work_manuals のコメント参照）。
// 権限: 連絡帳と同じく社員（staff/admin）だけ。owner・備品出庫限定ロールには閲覧も許さない
// （鍵の場所・暗証番号など社内の手順を含むため。2026-10-13 依頼元に確認済み）。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'

const COLUMNS = 'id, kind, no, title, fields, body, related_ids, created_at, updated_at'

// 分類ごとに持てる項目（fields のキー）。画面の見出しの順もこの順。
// 2026-10-13〜 分類は「対応方法（response）」「定例作業（routine）」の2つ（旧「関連手順（procedure）」は定例作業へ統合）。
// 手順の本文（body）はどちらの分類でも持てる
export const MANUAL_FIELDS = {
  response: ['method', 'contact', 'note'],
  routine: ['timing', 'items', 'place', 'content', 'after', 'remark'],
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function requireStaff(req) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return { error: json({ error: '認証が必要です' }, 401) }
  if (!canWrite(auth)) return { error: json({ error: 'この画面を使う権限がありません' }, 403) }
  return { auth }
}

function text(value, max) {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n?/g, '\n').trim().slice(0, max)
}

// 画面から送られた値を、種類に合った形に整える。誤りがあれば { error }
function normalize(payload, kind) {
  const title = text(payload.title, 200)
  if (!title) return { error: '項目名（依頼・問い合わせ例／作業名／手順名）を入力してください' }
  const fields = {}
  for (const key of MANUAL_FIELDS[kind]) {
    const v = text(payload.fields?.[key], 4000)
    if (v) fields[key] = v
  }
  const body = text(payload.body, 20000) || null
  const related = Array.isArray(payload.related_ids)
    ? [...new Set(payload.related_ids.filter((id) => typeof id === 'string' && UUID_RE.test(id)))].slice(0, 20)
    : []
  const no = payload.no === '' || payload.no == null ? null : Number(payload.no)
  if (no !== null && (!Number.isInteger(no) || no < 0 || no > 9999)) return { error: 'No は0〜9999の整数で入力してください' }
  return { row: { title, fields, body, related_ids: related, no } }
}

// GET /api/manuals — 全件（種類→No 順）。キーワード検索は画面側で行う
export async function handleManualList(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const { data, error: err } = await getAdminClient()
      .from('work_manuals')
      .select(COLUMNS)
      .order('kind', { ascending: true })
      .order('no', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
    if (err) throw err
    return json({ manuals: data || [] })
  } catch (err) {
    console.error('manual-list 失敗:', err)
    return json({ error: '業務マニュアルの取得に失敗しました' }, 500)
  }
}

// POST /api/manuals — 追加。No が空なら、その種類の最大 No + 1 を振る
export async function handleManualCreate(req) {
  const { auth, error } = await requireStaff(req)
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const kind = payload?.kind
    if (!MANUAL_FIELDS[kind]) return json({ error: '種類が不正です' }, 400)
    const { row, error: invalid } = normalize(payload, kind)
    if (invalid) return json({ error: invalid }, 400)

    const supabase = getAdminClient()
    if (row.no === null) {
      const { data: last } = await supabase
        .from('work_manuals')
        .select('no')
        .eq('kind', kind)
        .not('no', 'is', null)
        .order('no', { ascending: false })
        .limit(1)
        .maybeSingle()
      row.no = (last?.no || 0) + 1
    }
    const { data, error: err } = await supabase
      .from('work_manuals')
      .insert({ ...row, kind, created_by: auth.sub, updated_by: auth.sub })
      .select(COLUMNS)
      .single()
    if (err) throw err
    return json({ manual: data })
  } catch (err) {
    console.error('manual-create 失敗:', err)
    return json({ error: '業務マニュアルの追加に失敗しました' }, 500)
  }
}

// PATCH /api/manuals — 更新。分類（kind）も変えられる（2026-10-13〜。修正画面のラベルから選び直す）
export async function handleManualUpdate(req) {
  const { auth, error } = await requireStaff(req)
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!UUID_RE.test(id)) return json({ error: 'id が不正です' }, 400)
    const supabase = getAdminClient()
    const { data: existing } = await supabase.from('work_manuals').select('id, kind').eq('id', id).maybeSingle()
    if (!existing) return json({ error: '項目が見つかりません' }, 404)
    const kind = MANUAL_FIELDS[payload.kind] ? payload.kind : existing.kind
    const { row, error: invalid } = normalize(payload, kind)
    if (invalid) return json({ error: invalid }, 400)
    row.kind = kind
    row.related_ids = row.related_ids.filter((r) => r !== id)
    const { data, error: err } = await supabase
      .from('work_manuals')
      .update({ ...row, updated_by: auth.sub })
      .eq('id', id)
      .select(COLUMNS)
      .single()
    if (err) throw err
    return json({ manual: data })
  } catch (err) {
    console.error('manual-update 失敗:', err)
    return json({ error: '業務マニュアルの更新に失敗しました' }, 500)
  }
}

// DELETE /api/manuals?id=… — 削除。ほかの項目の「関連」からも外す
export async function handleManualDelete(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!UUID_RE.test(id)) return json({ error: 'id が不正です' }, 400)
    const supabase = getAdminClient()
    const { data: referrers } = await supabase.from('work_manuals').select('id, related_ids').contains('related_ids', [id])
    for (const r of referrers || []) {
      await supabase
        .from('work_manuals')
        .update({ related_ids: (r.related_ids || []).filter((x) => x !== id) })
        .eq('id', r.id)
    }
    const { error: err } = await supabase.from('work_manuals').delete().eq('id', id)
    if (err) throw err
    return json({ ok: true })
  } catch (err) {
    console.error('manual-delete 失敗:', err)
    return json({ error: '業務マニュアルの削除に失敗しました' }, 500)
  }
}
