// テナントへのメール（雛型からの一斉メール。2026-10-29〜）の API ハンドラ。
//
// 件名・本文の雛型（tenant_mail_templates）を複数持ち、選んだ雛型から「有効なテナント全員を BCC」に
// したメールを作る。宛先・返信先・「その他の宛先」はビルメンの案内メールの仕組み（worker/lib/bilmen.js）を
// そのまま使う。ビルメンの案内メールは kind='bilmen' の雛型として合流させた（連絡票PDFを添付するため、
// 作成はビルメンテナンス管理の「テナントへ報知」から。ここでは件名・本文を直すだけ）。
//
// 権限: 外部に出る操作の一部のため社員のみ（requireMailAccess。GET も含む）。
// 送信はしない（Gmail の下書きを作るか、mailto: で端末のメールソフトを開くだけ。人が確かめて送る）。

import { json } from './http.js'
import { getAdminClient } from './supabase-admin.js'
import { getAccessToken, createDraft } from './gmail.js'
import { buildMimeMessage } from './mime.js'
import { requireMailAccess, loadTenantRecipients, normalizeReplyTo, logBilmen, MAIL_SETTINGS_ID } from './bilmen.js'

const TEMPLATE_COLUMNS = 'id, kind, name, subject, body, include_others, sort_order, updated_by, created_at, updated_at'

function actorOf(auth) {
  return auth?.display_name || auth?.username || null
}

function buildTemplateRow(payload) {
  const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 100) : ''
  const subject = typeof payload?.subject === 'string' ? payload.subject.trim().slice(0, 200) : ''
  const body = typeof payload?.body === 'string' ? payload.body.slice(0, 5000) : ''
  if (!name) return { error: '雛型名は必須です' }
  if (!subject) return { error: '件名は必須です' }
  if (!body.trim()) return { error: '本文は必須です' }
  const row = {
    name,
    subject,
    body,
    include_others: typeof payload?.include_others === 'boolean' ? payload.include_others : true,
  }
  if (Number.isFinite(Number(payload?.sort_order)) && payload?.sort_order !== null && payload?.sort_order !== '') {
    row.sort_order = Number(payload.sort_order)
  }
  return { row }
}

// GET /api/tenant-mail/templates — 雛型の一覧（ビルメン → 表示順 → 雛型名）
export async function handleTenantMailTemplateList(req) {
  const { error } = await requireMailAccess(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('tenant_mail_templates')
      .select(TEMPLATE_COLUMNS)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
    if (err) {
      console.error('tenant-mail-template-list:', err.message)
      return json({ error: '雛型の取得に失敗しました' }, 500)
    }
    return json({ templates: data || [] })
  } catch (err) {
    console.error('tenant-mail-template-list 失敗:', err)
    return json({ error: '雛型の取得に失敗しました' }, 500)
  }
}

// POST /api/tenant-mail/templates — 雛型を追加（ビルメンの雛型は1つだけなので、ここで作るのは一般の雛型だけ）
export async function handleTenantMailTemplateCreate(req) {
  const { auth, error } = await requireMailAccess(req)
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const { row, error: buildErr } = buildTemplateRow(payload)
    if (buildErr) return json({ error: buildErr }, 400)
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('tenant_mail_templates')
      .insert({ ...row, kind: 'general', updated_by: actorOf(auth) })
      .select(TEMPLATE_COLUMNS)
      .single()
    if (err) {
      console.error('tenant-mail-template-create:', err.message)
      return json({ error: '雛型の登録に失敗しました' }, 500)
    }
    return json({ template: data }, 201)
  } catch (err) {
    console.error('tenant-mail-template-create 失敗:', err)
    return json({ error: '雛型の登録に失敗しました' }, 500)
  }
}

// PATCH /api/tenant-mail/templates — 雛型を更新（kind は変えられない）
export async function handleTenantMailTemplateUpdate(req) {
  const { auth, error } = await requireMailAccess(req)
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const { row, error: buildErr } = buildTemplateRow(payload)
    if (buildErr) return json({ error: buildErr }, 400)
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('tenant_mail_templates')
      .update({ ...row, updated_by: actorOf(auth) })
      .eq('id', id)
      .select(TEMPLATE_COLUMNS)
      .single()
    if (err) {
      console.error('tenant-mail-template-update:', err.message)
      return json({ error: '雛型の保存に失敗しました' }, 500)
    }
    return json({ template: data })
  } catch (err) {
    console.error('tenant-mail-template-update 失敗:', err)
    return json({ error: '雛型の保存に失敗しました' }, 500)
  }
}

// DELETE /api/tenant-mail/templates?id=… — 雛型を削除（ビルメンの雛型は消せない）
export async function handleTenantMailTemplateDelete(req) {
  const { error } = await requireMailAccess(req)
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('tenant_mail_templates')
      .delete()
      .eq('id', id)
      .eq('kind', 'general')
      .select('id')
    if (err) {
      console.error('tenant-mail-template-delete:', err.message)
      return json({ error: '雛型の削除に失敗しました' }, 500)
    }
    if (!data || data.length === 0) return json({ error: 'この雛型は削除できません' }, 400)
    return json({ ok: true })
  } catch (err) {
    console.error('tenant-mail-template-delete 失敗:', err)
    return json({ error: '雛型の削除に失敗しました' }, 500)
  }
}

// POST /api/tenant-mail/draft — 選んだ雛型から Gmail の下書きを作る（添付なし。送信はしない）
//   { template_id, subject, body }
//   subject・body は画面で変数を展開し、必要なら書き足したもの（プレビューと同じ文面を下書きにする）。
//   宛先（BCC）・返信先は**画面から受け取らずサーバー側でDBから引き直す**（ビルメンの下書きと同じ理由）。
//   宛先 = 今日の時点で退去していないテナントの「案内メールの宛先」＋（雛型が「その他の宛先も含める」なら）有効なその他の宛先
export async function handleTenantMailDraftCreate(req) {
  const { auth, error } = await requireMailAccess(req)
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const templateId = typeof payload?.template_id === 'string' ? payload.template_id : ''
    const subject = typeof payload?.subject === 'string' ? payload.subject.trim().slice(0, 200) : ''
    const body = typeof payload?.body === 'string' ? payload.body.slice(0, 5000) : ''
    if (!templateId) return json({ error: '雛型を選んでください' }, 400)
    if (!subject) return json({ error: '件名が空です' }, 400)
    if (!body.trim()) return json({ error: '本文が空です' }, 400)

    const supabase = getAdminClient()
    const { data: template, error: tplErr } = await supabase
      .from('tenant_mail_templates')
      .select('id, kind, name, include_others')
      .eq('id', templateId)
      .maybeSingle()
    if (tplErr) {
      console.error('tenant-mail-draft template:', tplErr.message)
      return json({ error: '雛型の取得に失敗しました' }, 500)
    }
    if (!template) return json({ error: '雛型が見つかりません' }, 404)
    if (template.kind === 'bilmen') {
      return json({ error: 'この雛型はビルメンテナンス管理の「テナントへ報知」から作成してください（連絡票を添付するため）' }, 400)
    }

    const [tenantRecipients, { data: others, error: recErr }, { data: shared }, { data: mailSettings }] = await Promise.all([
      loadTenantRecipients(supabase),
      template.include_others
        ? supabase.from('bilmen_mail_recipients').select('name, email').eq('disabled', false).order('sort_order', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      supabase.from('settings').select('value').eq('key', 'shared_gmail').maybeSingle(),
      supabase.from('bilmen_mail_settings').select('reply_to').eq('id', MAIL_SETTINGS_ID).maybeSingle(),
    ])
    if (recErr) {
      console.error('tenant-mail-draft recipients:', recErr.message)
      return json({ error: '宛先の取得に失敗しました' }, 500)
    }
    const seen = new Set()
    const bcc = [...tenantRecipients, ...(others || [])].filter((r) => {
      const key = (r.email || '').trim().toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (bcc.length === 0) {
      return json({ error: '宛先がありません。テナントマスタの「案内メールの宛先」に登録してください' }, 400)
    }

    // 返信先は本文の末尾にも書き添える（Gmail の画面から送ると Reply-To ヘッダーが落ちるため。
    // ビルメンの下書きと同じ。docs/bilmen-plan.md 7-3-3）
    const replyTo = normalizeReplyTo(mailSettings?.reply_to || '')
    const draftBody = replyTo.value
      ? `${body.replace(/\s+$/, '')}\n\nご返信は ${replyTo.value} までお願いいたします。\n`
      : body
    const raw = buildMimeMessage({
      bcc,
      replyTo: replyTo.value ? [{ email: replyTo.value }] : [],
      subject,
      body: draftBody,
    })
    const accessToken = await getAccessToken()
    const draft = await createDraft(accessToken, raw)

    const account = (shared?.value || '').trim()
    const base = `https://mail.google.com/mail/${account ? `?authuser=${encodeURIComponent(account)}` : 'u/0/'}`
    const messageId = draft?.message?.id || ''

    await logBilmen(supabase, actorOf(auth), `テナントへのメール: 「${template.name}」の下書きを作成しました（宛先 ${bcc.length} 件）`, {
      template_id: template.id,
      draft_id: draft?.id || null,
      message_id: messageId || null,
      recipients: bcc.length,
      reply_to: replyTo.value || null,
    })

    return json({
      draft_id: draft?.id || null,
      message_id: messageId || null,
      recipient_count: bcc.length,
      reply_to: replyTo.value || null,
      draft_url: messageId ? `${base}#drafts?compose=${messageId}` : `${base}#drafts`,
      drafts_url: `${base}#drafts`,
    })
  } catch (err) {
    console.error('tenant-mail-draft:', err)
    return json({ error: err instanceof Error ? err.message : '下書きの作成に失敗しました' }, 500)
  }
}
