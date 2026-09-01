// 連絡帳（顧客の連絡先台帳）機能のAPIハンドラ（2026-08-31〜）。
// タスク・メールの取得実績（tasks.sender_email 等）から自動作成できるほか、手動でも登録・編集できる。
// 権限: equipment.js・documents.js と同じ形（staff/admin は読み書き、owner・備品出庫限定ロールは閲覧のみ）。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'

const CONTACT_COLUMNS =
  'id, company_name, business_category, contact_person, staff_name, company_phone, mobile_phone, ' +
  'email_to, email_cc, website_url, created_via, created_at, updated_at'

async function requireAuth(req, { write = false } = {}) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return { error: json({ error: '認証が必要です' }, 401) }
  if (write && !canWrite(auth)) {
    return { error: json({ error: 'この操作を行う権限がありません' }, 403) }
  }
  return { auth }
}

function trimOrNull(value, max = 500) {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t ? t.slice(0, max) : null
}

// GET /api/contacts — 一覧（会社名順。検索・絞り込みは画面側で行う想定の件数規模のため、
// サーバー側では絞り込みを持たない）
export async function handleContactList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('contacts')
      .select(CONTACT_COLUMNS)
      .order('company_name', { ascending: true })
    if (err) {
      console.error('contact-list:', err.message)
      return json({ error: '連絡帳の取得に失敗しました' }, 500)
    }
    return json({ contacts: data || [] })
  } catch (err) {
    console.error('contact-list 失敗:', err)
    return json({ error: '連絡帳の取得に失敗しました' }, 500)
  }
}

// GET /api/contacts/suggest — 業務分類の候補（重複除く。直近登録が先頭。まだ運用が曖昧な項目のため
// 選択式には強制せず、既存値からの入力補助にとどめる。equipment.js の担当者候補と同じ考え方）
export async function handleContactCategorySuggest(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('contacts')
      .select('business_category')
      .order('created_at', { ascending: false })
      .limit(500)
    if (err) {
      console.error('contact-category-suggest:', err.message)
      return json({ error: '候補の取得に失敗しました' }, 500)
    }
    const seen = new Map()
    for (const r of data || []) {
      if (r.business_category && !seen.has(r.business_category)) seen.set(r.business_category, seen.size)
    }
    return json({ values: [...seen.keys()].slice(0, 50) })
  } catch (err) {
    console.error('contact-category-suggest 失敗:', err)
    return json({ error: '候補の取得に失敗しました' }, 500)
  }
}

function buildContactRow(payload) {
  const companyName = trimOrNull(payload?.company_name, 200)
  if (!companyName) return { error: '会社名は必須です' }
  const emailTo = trimOrNull(payload?.email_to, 254)
  if (emailTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTo)) {
    return { error: 'メールTOの形式が正しくありません' }
  }
  return {
    row: {
      company_name: companyName,
      business_category: trimOrNull(payload?.business_category, 100),
      contact_person: trimOrNull(payload?.contact_person, 100),
      staff_name: trimOrNull(payload?.staff_name, 100),
      company_phone: trimOrNull(payload?.company_phone, 30),
      mobile_phone: trimOrNull(payload?.mobile_phone, 30),
      email_to: emailTo,
      email_cc: trimOrNull(payload?.email_cc, 500),
      website_url: trimOrNull(payload?.website_url, 500),
    },
  }
}

// POST /api/contacts — 手動登録
export async function handleContactCreate(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const { row, error: validationError } = buildContactRow(payload)
    if (validationError) return json({ error: validationError }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('contacts')
      .insert({ ...row, created_via: 'manual' })
      .select(CONTACT_COLUMNS)
      .single()
    if (err) {
      console.error('contact-create:', err.message)
      const msg = err.code === '23505' ? 'このメールTOは既に登録されています' : '連絡先の登録に失敗しました'
      return json({ error: msg }, err.code === '23505' ? 409 : 500)
    }
    return json({ contact: data })
  } catch (err) {
    console.error('contact-create 失敗:', err)
    return json({ error: '連絡先の登録に失敗しました' }, 500)
  }
}

// PATCH /api/contacts — 修正
export async function handleContactUpdate(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const { row, error: validationError } = buildContactRow(payload)
    if (validationError) return json({ error: validationError }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('contacts')
      .update(row)
      .eq('id', id)
      .select(CONTACT_COLUMNS)
      .maybeSingle()
    if (err) {
      console.error('contact-update:', err.message)
      const msg = err.code === '23505' ? 'このメールTOは既に登録されています' : '連絡先の更新に失敗しました'
      return json({ error: msg }, err.code === '23505' ? 409 : 500)
    }
    if (!data) return json({ error: '連絡先が見つかりません' }, 404)
    return json({ contact: data })
  } catch (err) {
    console.error('contact-update 失敗:', err)
    return json({ error: '連絡先の更新に失敗しました' }, 500)
  }
}

// DELETE /api/contacts?id=…
export async function handleContactDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)

    const supabase = getAdminClient()
    const { error: err } = await supabase.from('contacts').delete().eq('id', id)
    if (err) {
      console.error('contact-delete:', err.message)
      return json({ error: '連絡先の削除に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('contact-delete 失敗:', err)
    return json({ error: '連絡先の削除に失敗しました' }, 500)
  }
}

// POST /api/contacts/sync — タスク（メール取得実績）から連絡帳を自動作成する。
// tasks.sender_email（大文字小文字を区別せず重複除去）ごとに、まだ連絡帳に無いものだけ
// 新規作成する（既存の連絡帳は上書きしない＝手動で編集した内容を壊さない）。
// スパム判定済み・sender_email が空のタスクは対象外。
export async function handleContactSync(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data: taskRows, error: taskErr } = await supabase
      .from('tasks')
      .select('sender_display, contact, sender_email, sender_cc, received_at')
      .eq('is_spam', false)
      .not('sender_email', 'is', null)
      .order('received_at', { ascending: true })
    if (taskErr) {
      console.error('contact-sync(tasks):', taskErr.message)
      return json({ error: '連絡帳の自動作成に失敗しました' }, 500)
    }

    // 同一アドレスは複数タスクにまたがるため、そのアドレスで最後に届いたメールの情報
    // （会社名・担当者名・CC）を採用する（受信日時の昇順で読み込み、後勝ちで上書きするだけでよい）
    const byEmail = new Map()
    for (const t of taskRows || []) {
      const email = (t.sender_email || '').trim().toLowerCase()
      if (!email) continue
      byEmail.set(email, t)
    }
    if (byEmail.size === 0) return json({ created: 0, skipped: 0 })

    const { data: existingContacts, error: existErr } = await supabase.from('contacts').select('email_to')
    if (existErr) {
      console.error('contact-sync(existing):', existErr.message)
      return json({ error: '連絡帳の自動作成に失敗しました' }, 500)
    }
    const existingEmails = new Set(
      (existingContacts || []).map((c) => (c.email_to || '').trim().toLowerCase()).filter(Boolean)
    )

    const toInsert = []
    for (const [email, t] of byEmail) {
      if (existingEmails.has(email)) continue
      toInsert.push({
        company_name: t.sender_display || t.contact || email,
        contact_person: t.contact && t.contact !== t.sender_display ? t.contact : null,
        email_to: email,
        email_cc: t.sender_cc || null,
        created_via: 'auto',
      })
    }
    if (toInsert.length === 0) return json({ created: 0, skipped: byEmail.size })

    const { error: insertErr } = await supabase.from('contacts').insert(toInsert)
    if (insertErr) {
      console.error('contact-sync(insert):', insertErr.message)
      return json({ error: '連絡帳の自動作成に失敗しました' }, 500)
    }
    return json({ created: toInsert.length, skipped: byEmail.size - toInsert.length })
  } catch (err) {
    console.error('contact-sync 失敗:', err)
    return json({ error: '連絡帳の自動作成に失敗しました' }, 500)
  }
}
