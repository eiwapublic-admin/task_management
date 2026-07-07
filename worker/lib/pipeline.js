import { getAdminClient } from './supabase-admin.js'
import { getAccessToken, listMessageIds, getMessage, getThreadLatest } from './gmail.js'
import { resolveCalendar, listTodayEvents } from './calendar.js'
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

function emailDomain(addr) {
  const at = typeof addr === 'string' ? addr.lastIndexOf('@') : -1
  return at > 0 ? addr.slice(at + 1).toLowerCase() : null
}

// 本文を整形する。改行の正規化に加えて、
// - 返信/転送メールの行頭引用マーク（"> " や全角 "＞"、ネストした ">> " 等）を除去
// - BOM・ゼロ幅スペース等の不可視文字を除去
// し、行末の空白と連続改行を1つに圧縮する。
function compactBody(text) {
  return (text || '')
    .replace(/\r\n?/g, '\n')
    // 不可視文字（ゼロ幅スペース類・BOM）を除去
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    // 各行頭の引用マークを除去（半角 ">"・全角 "＞"、前後の空白やネストにも対応）
    .replace(/^[ \t　]*(?:[>＞]+[ \t　]*)+/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

// HTML を含みうる文字列からタグを除いてテキスト化する
function stripHtml(text) {
  return (text || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

// イベント詳細から「担当：〜」の担当者名を取り出す（全角/半角コロン対応）
function extractCalendarAssignee(text) {
  const m = (text || '').match(/担当(?:者)?\s*[：:]\s*([^\s、,，\n]+)/)
  return m ? m[1].trim() : null
}

// 件名から Re:/Fwd: 等の接頭辞を除いて比較用に正規化する
function normalizeSubject(subject) {
  let t = (subject || '').trim()
  for (;;) {
    const next = t.replace(/^(re|fwd?|返信)\s*[:：]\s*/i, '')
    if (next === t) break
    t = next.trim()
  }
  return t.toLowerCase()
}

// 操作ログの保持期間（日）。古いログはパイプライン実行時に削除する
const LOG_RETENTION_DAYS = 60

// runPipeline: 取得〜分類〜保存〜返信検知〜last_fetch更新までを一括実行する。
// force=true のときは更新間隔ゲートを無視して即時実行する（手動実行用）。
// actor は操作ログに記録する実行者（手動実行時はログインユーザーの表示名）。
export async function runPipeline({ force = false, actor = 'システム（自動）' } = {}) {
  const supabase = getAdminClient()
  const settings = await loadSettings(supabase)

  const intervalMin = Math.max(1, Number(settings.fetch_interval_minutes) || 30)
  const lastFetchAt = settings.last_fetch_at ? new Date(settings.last_fetch_at) : null
  const assignees = parseAssignees(settings.assignees)
  const orgContext = settings.org_context || ''
  const businessKeywords = settings.business_keywords || ''
  const sharedGmail = (settings.shared_gmail || '').toLowerCase()
  // 自社ドメイン。担当者が自分のメーラーから返信（CC: 社内ML経由で共有アドレスに配信）した場合の返信検知に使う
  const companyDomains = (settings.company_domains || 'eiwa-up.jp')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const isCompanyAddress = (addr) => {
    const a = (addr || '').toLowerCase()
    return Boolean(a) && (a === sharedGmail || companyDomains.includes(emailDomain(a)))
  }

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
  const logRows = []

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

  // 未処理タスクの一覧（件名ベースの返信検知用）。
  // 担当者が自分のメーラーから返信すると References ヘッダーが付かず
  // 元スレッドに紐付かないことがあるため、件名の一致でも返信を検知する。
  const { data: openTaskRows } = await supabase
    .from('tasks')
    .select('id, gmail_thread_id, gmail_message_id, title, subject, sender, sender_email, classification_note')
    .eq('status', '未処理')
    .eq('source', 'email')
  const openBySubject = new Map()
  for (const t of openTaskRows || []) openBySubject.set(normalizeSubject(t.subject), t)

  // タスクを「返信済み」にし、操作ログを積む（返信検知の共通処理）。
  // reply（返信メール）が渡された場合は、タスクの詳細内容を返信の本文全体で
  // 置き換える（元のメール内容は返信内の引用として残っている想定）。
  async function markReplied(task, via, reply = null) {
    const fields = { status: '返信済み' }
    if (reply && reply.body) {
      fields.body_preview = compactBody(reply.body).slice(0, 500)
      const note = `【返信検知】${via}（差出人: ${reply.from || '不明'}）。本文を返信の内容に置き換えました。元のメールは返信内の引用を参照。`
      fields.classification_note = task.classification_note
        ? `${task.classification_note}\n${note}`
        : note
    }
    const { error } = await supabase
      .from('tasks')
      .update(fields)
      .eq('id', task.id)
      .eq('status', '未処理')
    if (error) return false
    summary.replied += 1
    openBySubject.delete(normalizeSubject(task.subject))
    logRows.push({
      log_type: 'status_change',
      actor: 'システム（自動）',
      message: `「${task.title}」のステータスを 未処理 → 返信済み に変更（${via}）`,
      detail: { task_id: task.id },
    })
    return true
  }

  // 2) 新規メッセージを分類してタスク化
  for (const ref of messageRefs) {
    try {
      const email = await getMessage(accessToken, ref.id)
      if (!email.threadId) continue

      // 件名ベースの返信検知: 未処理タスクと同じ件名（Re: 等を除く）のメールが
      // 自社側（共有アドレス・自社ドメイン）から、かつ元の送信者（顧客）宛てに
      // 送られたものであれば、そのタスクへの返信とみなす（Claude 分類はスキップ）。
      //
      // 「顧客宛てに送られている」ことを必須にするのが重要。問い合わせフォーム由来の
      // メールは件名が定型（例:「ホームページからのお問い合わせ」）で共通し、From も
      // 自社ドメイン（if@eiwa-up.jp 等）になるため、From が自社という条件だけだと
      // 別顧客の新規フォーム送信を既存タスクへの「返信」と誤検知してしまう。
      // 正当な返信は必ず顧客（counterpart）を宛先に含むので、その一致を要件に加える。
      const fromEmail = (extractEmail(email.from) || '').toLowerCase()
      const openTask = openBySubject.get(normalizeSubject(email.subject))
      if (openTask && email.id !== openTask.gmail_message_id) {
        const counterpart = (openTask.sender_email || extractEmail(openTask.sender) || '').toLowerCase()
        const recipients = `${email.to || ''} ${email.cc || ''}`.toLowerCase()
        const sentToCounterpart = counterpart && recipients.includes(counterpart)
        const isOurReply =
          fromEmail && fromEmail !== counterpart && isCompanyAddress(fromEmail) && sentToCounterpart
        if (isOurReply) {
          await markReplied(openTask, '返信を検知', email)
          continue
        }
      }

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
        body_preview: compactBody(email.body).slice(0, 500),
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

  // 3) スレッドベースの返信検知: 未処理タスクのスレッド最新メールが
  //    自社側（共有アドレス or 自社ドメイン）発なら「返信済み」に
  {
    const { data: openTasks } = await supabase
      .from('tasks')
      .select('id, gmail_thread_id, gmail_message_id, title, subject, sender, sender_email, classification_note')
      .eq('status', '未処理')
      .eq('source', 'email')
    for (const task of openTasks || []) {
      try {
        const latest = await getThreadLatest(accessToken, task.gmail_thread_id)
        // タスク登録の元になったメール自体や、元の差出人による追加送信は「返信」ではない
        // （社内発・フォームシステム発のメールは From が自社ドメインのため、
        //   このガードが無いと返信ゼロでも誤検知する）
        const latestFrom = (extractEmail(latest?.from) || '').toLowerCase()
        const originalFrom = (extractEmail(task.sender) || '').toLowerCase()
        if (
          latest &&
          latest.id !== task.gmail_message_id &&
          latestFrom !== originalFrom &&
          isCompanyAddress(latestFrom)
        ) {
          // 返信の本文でタスク詳細を置き換えるため、最新メッセージ全体を取得する
          const replyEmail = await getMessage(accessToken, latest.id)
          await markReplied(task, 'スレッドで返信を検知', replyEmail)
        }
      } catch (err) {
        summary.errors.push(`reply-check: ${String(err.message || err)}`)
      }
    }
  }

  // 3.5) Google カレンダー「栄和共通」の当日イベントをタスク化（未処理に登録）
  summary.calendarCreated = 0
  const calendarName = (settings.calendar_name || '栄和共通').trim()
  if (calendarName) {
    try {
      // calendar_name に '@' が含まれる場合はカレンダーID直接指定とみなす
      // （calendarList に出ないカレンダーでも、公開カレンダーなら ID で読める）。
      // それ以外は表示名で calendarList から解決する。
      let calendarId = null
      let available = []
      if (calendarName.includes('@')) {
        calendarId = calendarName
      } else {
        const resolved = await resolveCalendar(accessToken, calendarName)
        calendarId = resolved.id
        available = resolved.available
      }
      if (!calendarId) {
        summary.errors.push(
          `calendar: カレンダー「${calendarName}」が見つかりません。利用可能なカレンダー: ${
            available.length ? available.join(' / ') : '（なし）'
          }`
        )
      } else {
        const events = await listTodayEvents(accessToken, calendarId)
        for (const ev of events) {
          const key = `cal:${ev.id}`
          if (existingThreads.has(key)) continue
          const desc = compactBody(stripHtml(ev.description))
          // 詳細に「担当：〜」があれば担当者に採用。無ければ既定担当（先頭）
          const assignee = extractCalendarAssignee(desc) || assignees[0]
          const { error: calErr } = await supabase.from('tasks').insert({
            gmail_thread_id: key,
            gmail_message_id: ev.id,
            source: 'calendar',
            title: (ev.title || '（無題の予定）').slice(0, 120),
            assignee,
            status: '未処理',
            due_date: ev.startDate || todayJST(),
            sender: calendarName.includes('@') ? 'Googleカレンダー' : `Googleカレンダー「${calendarName}」`,
            sender_display: null,
            sender_email: null,
            subject: ev.title || '（無題の予定）',
            body_preview: desc.slice(0, 500),
            received_at: ev.start || new Date().toISOString(),
            classification_note: `Googleカレンダー「${calendarName}」の当日イベントから自動登録。`,
          })
          if (calErr) {
            if (!/duplicate key|unique/i.test(calErr.message)) {
              summary.errors.push(`calendar-insert: ${calErr.message}`)
            }
          } else {
            summary.calendarCreated += 1
            existingThreads.add(key)
          }
        }
      }
    } catch (err) {
      const msg = err.isScopeError
        ? `calendar: カレンダー参照の権限がありません（OAuth トークンに calendar スコープの再付与が必要）: ${err.message}`
        : `calendar: ${String(err.message || err)}`
      summary.errors.push(msg)
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

  // 6) 操作ログの書き込み（取得サマリー + 自動ステータス変更）と古いログの削除
  const fetchMessage =
    `メール取得: 取得 ${summary.fetched} 件 / 新規タスク ${summary.created} 件 / ` +
    `返信検知 ${summary.replied} 件 / 業務外 ${summary.nonBusiness} 件 / ` +
    `カレンダー登録 ${summary.calendarCreated} 件` +
    (summary.errors.length > 0 ? ` / エラー ${summary.errors.length} 件（${summary.errors[0]}）` : '')
  logRows.unshift({ log_type: 'fetch', actor, message: fetchMessage, detail: summary })
  const { error: logError } = await supabase.from('activity_logs').insert(logRows)
  if (logError) console.error('操作ログの書き込みに失敗:', logError.message)
  await supabase
    .from('activity_logs')
    .delete()
    .lt('created_at', new Date(Date.now() - LOG_RETENTION_DAYS * 86400000).toISOString())

  // 7) last_fetch_at を更新
  await supabase
    .from('settings')
    .update({ value: new Date().toISOString() })
    .eq('key', 'last_fetch_at')

  return summary
}
