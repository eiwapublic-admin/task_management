import { getAdminClient } from './supabase-admin.js'
import { getAccessToken, listMessageIds, getMessage, getThreadLatestFrom } from './gmail.js'
import { classifyEmail } from './anthropic.js'

// 1回の取得で処理するメッセージ上限（コスト・実行時間の保護）
const MAX_MESSAGES = 40

const DEFAULT_ASSIGNEES = ['橋口', '西川', '岡田']

function todayJST() {
  // en-CA ロケールは YYYY-MM-DD 形式を返す
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
}

// settings テーブルを { key: value } のオブジェクトにして返す
async function loadSettings(supabase) {
  const { data, error } = await supabase.from('settings').select('key, value')
  if (error) throw new Error(`settings の読み込みに失敗: ${error.message}`)
  const map = {}
  for (const row of data) map[row.key] = row.value
  return map
}

function parseAssignees(raw) {
  if (!raw) return DEFAULT_ASSIGNEES
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) && arr.length > 0 ? arr : DEFAULT_ASSIGNEES
  } catch {
    return DEFAULT_ASSIGNEES
  }
}

const DUE_RE = /^\d{4}-\d{2}-\d{2}$/
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

// 文字列から最初のメールアドレスを取り出す（"名前 <a@b.jp>" 形式にも対応）
function extractEmail(str) {
  const m = typeof str === 'string' ? str.match(EMAIL_RE) : null
  return m ? m[0] : null
}

// runPipeline: 取得〜分類〜保存〜返信検知〜last_fetch更新までを一括実行する。
// force=true のときは更新間隔ゲートを無視して即時実行する（手動実行用）。
export async function runPipeline({ force = false } = {}) {
  const supabase = getAdminClient()
  const settings = await loadSettings(supabase)

  const intervalMin = Math.max(1, Number(settings.fetch_interval_minutes) || 30)
  const lastFetchAt = settings.last_fetch_at ? new Date(settings.last_fetch_at) : null
  const assignees = parseAssignees(settings.assignees)
  const orgContext = settings.org_context || ''
  const businessKeywords = settings.business_keywords || ''
  const sharedGmail = (settings.shared_gmail || '').toLowerCase()

  // 稼働時間帯ゲート: 業務時間外はスケジュール実行をスキップする（手動実行は対象外）
  if (!force) {
    const startHour = Number.isFinite(Number(settings.active_hours_start))
      ? Number(settings.active_hours_start)
      : 8
    const endHour = Number.isFinite(Number(settings.active_hours_end))
      ? Number(settings.active_hours_end)
      : 18
    const hourJST = Number(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo', hour: 'numeric', hour12: false })
    )
    if (hourJST < startHour || hourJST >= endHour) {
      return {
        skipped: true,
        reason: `稼働時間外（現在${hourJST}時 / 稼働 ${startHour}〜${endHour}時）`,
        created: 0,
      }
    }
  }

  // 更新間隔ゲート（スケジュール実行時のコスト抑制）
  if (!force && lastFetchAt) {
    const elapsedMin = (Date.now() - lastFetchAt.getTime()) / 60000
    if (elapsedMin < intervalMin) {
      return { skipped: true, reason: `前回取得から${Math.round(elapsedMin)}分（間隔${intervalMin}分）`, created: 0 }
    }
  }

  const summary = { fetched: 0, created: 0, replied: 0, nonBusiness: 0, errors: [], creditAlert: null }

  // Claude 利用量の集計とクレジット不足の検知
  let usageInput = 0
  let usageOutput = 0
  let classifyCalls = 0
  let billingError = null

  const accessToken = await getAccessToken()

  // 1) 新着メールの取得クエリを組み立てる
  let query = 'in:inbox'
  if (lastFetchAt) {
    query += ` after:${Math.floor(lastFetchAt.getTime() / 1000)}`
  } else {
    // 初回は直近1日分だけを対象にする（過去の大量メールを一気に取り込まない）
    query += ' newer_than:1d'
  }

  const messageRefs = await listMessageIds(accessToken, query, MAX_MESSAGES)
  summary.fetched = messageRefs.length

  // 既にDBにあるスレッドはスキップ
  const { data: existingRows } = await supabase.from('tasks').select('gmail_thread_id')
  const existingThreads = new Set((existingRows || []).map((r) => r.gmail_thread_id))
  const processedThreads = new Set()

  const context = { assignees, orgContext, businessKeywords, today: todayJST() }

  // 2) 新規メッセージを分類してタスク化
  for (const ref of messageRefs) {
    try {
      const email = await getMessage(accessToken, ref.id)
      if (!email.threadId) continue
      if (existingThreads.has(email.threadId) || processedThreads.has(email.threadId)) continue
      processedThreads.add(email.threadId)

      const { classification: result, usage } = await classifyEmail(email, context)
      usageInput += usage.input_tokens
      usageOutput += usage.output_tokens
      classifyCalls += 1

      if (!result.is_business_task) {
        summary.nonBusiness += 1
        continue
      }

      // 担当者の正規化（不明・範囲外は既定担当=先頭の担当者に）
      let assignee = result.assignee
      if (!assignee || !assignees.includes(assignee)) assignee = assignees[0]

      const dueDate = typeof result.due_date === 'string' && DUE_RE.test(result.due_date)
        ? result.due_date
        : null

      const title = (result.title || email.subject || '（件名なし）').slice(0, 120)

      // 送信元の会社・氏名（Claude が件名/本文から抽出。フォーム経由は本文優先）
      const senderDisplay =
        typeof result.sender_display === 'string' && result.sender_display.trim()
          ? result.sender_display.trim().slice(0, 120)
          : null

      // 返信先アドレス: Claude の抽出（フォーム経由は本文のアドレス）を優先し、
      // 無ければ Reply-To → From の順にフォールバック
      const senderEmail =
        extractEmail(result.sender_email) || extractEmail(email.replyTo) || extractEmail(email.from)

      const { error: insertError } = await supabase.from('tasks').insert({
        gmail_thread_id: email.threadId,
        gmail_message_id: email.id,
        title,
        assignee,
        status: '未処理',
        due_date: dueDate,
        sender: email.from || '（不明）',
        sender_display: senderDisplay,
        sender_email: senderEmail,
        subject: email.subject || '（件名なし）',
        body_preview: (email.body || '').slice(0, 500),
        received_at: email.receivedAt || new Date().toISOString(),
        classification_note: result.reason || null,
      })

      if (insertError) {
        // 一意制約違反（既に取り込み済み）は無視。それ以外は記録。
        if (!/duplicate key|unique/i.test(insertError.message)) {
          summary.errors.push(`insert: ${insertError.message}`)
        }
      } else {
        summary.created += 1
        existingThreads.add(email.threadId)
      }
    } catch (err) {
      summary.errors.push(String(err.message || err))
      // クレジット不足なら以降の分類も必ず失敗するので打ち切る
      if (err.isBillingError) {
        billingError = String(err.message || err)
        break
      }
    }
  }

  // 3) 返信検知: 未処理タスクのスレッド最新メールが共有アドレス発なら「返信済み」に
  if (sharedGmail) {
    const { data: openTasks } = await supabase
      .from('tasks')
      .select('id, gmail_thread_id')
      .eq('status', '未処理')
    for (const task of openTasks || []) {
      try {
        const latestFrom = await getThreadLatestFrom(accessToken, task.gmail_thread_id)
        if (latestFrom && latestFrom.toLowerCase().includes(sharedGmail)) {
          const { error } = await supabase
            .from('tasks')
            .update({ status: '返信済み' })
            .eq('id', task.id)
            .eq('status', '未処理')
          if (!error) summary.replied += 1
        }
      } catch (err) {
        summary.errors.push(`reply-check: ${String(err.message || err)}`)
      }
    }
  }

  // 4) Claude 利用量を月次で加算（推定コスト表示用）
  if (classifyCalls > 0) {
    const month = todayJST().slice(0, 7) // YYYY-MM
    const { error: usageError } = await supabase.rpc('add_api_usage', {
      p_month: month,
      p_input: usageInput,
      p_output: usageOutput,
      p_calls: classifyCalls,
    })
    if (usageError) summary.errors.push(`usage: ${usageError.message}`)
  }

  // 5) クレジット不足アラートの設定／解除
  if (billingError) {
    summary.creditAlert = billingError
    await supabase.from('settings').upsert(
      { key: 'api_credit_alert', value: JSON.stringify({ message: billingError, at: new Date().toISOString() }) },
      { onConflict: 'key' }
    )
  } else if (classifyCalls > 0) {
    // 正常に分類できたのでアラートを解除
    await supabase.from('settings').upsert(
      { key: 'api_credit_alert', value: '' },
      { onConflict: 'key' }
    )
  }

  summary.usage = { input_tokens: usageInput, output_tokens: usageOutput, calls: classifyCalls }

  // 6) last_fetch_at を更新
  await supabase
    .from('settings')
    .update({ value: new Date().toISOString() })
    .eq('key', 'last_fetch_at')

  return summary
}
