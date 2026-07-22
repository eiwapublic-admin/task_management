import { getAdminClient } from './supabase-admin.js'
import { getAccessToken, getProfile, listMessageIds, getMessage, getThreadMessages, getAttachmentData } from './gmail.js'
import { resolveCalendar, listTodayEvents } from './calendar.js'
import { classifyEmail } from './anthropic.js'
import { notifyNewTask } from './push.js'

// 1回の取得で処理するメッセージ上限（コスト・実行時間の保護）
const MAX_MESSAGES = 40

// タスク本文（body_preview）に保存する最大文字数。引用された過去のやり取り
// （初回発信メールまで）も含めて全文を残せるよう十分大きく取る。暴走メール対策の上限。
const MAX_BODY_PREVIEW = 20000

const DEFAULT_ASSIGNEES = ['橋口', '西川', '岡田']

// カード・詳細画面のアイコン表示用の経路種別。source='email' のタスクのみ
// Claude の分類結果から決める（メール/フォーム/FAX の区別）。
const CHANNEL_VALUES = new Set(['email', 'form', 'fax'])

// お問い合わせフォームの自動送信メールは件名・本文冒頭の定型文が固定のため、
// Claude の判断に頼らずここで確実に判定する（"channel" 分類漏れ対策）。
const FORM_BODY_MARKER = 'ホームページよりお問い合わせがありました'
const FORM_SUBJECT_MARKER = 'ホームページからのお問い合わせ'
function isFormSubmission(email) {
  const subject = email.subject || ''
  const body = email.body || ''
  return subject.includes(FORM_SUBJECT_MARKER) || body.includes(FORM_BODY_MARKER)
}

// 實守紙業（取引先）から定期的に届く「数量報告」メール。org_contextに
// 「實守紙業の数量報告は西川が担当」と明記された既知の業務メールだが、
// 2026-07-07・07-22に is_business_task=false と誤判定されタスク化されず
// 見落とされる事象が実際に発生した（本文がほぼ定型文のみで、Claudeの
// 業務判定が安定しないと見られる）。フォーム自動送信メールの判定と同様に、
// Claudeの判断に頼らずここで確実に業務メールとして扱う。
const JITSUMORI_SENDER_RE = /jitsumori\.co\.jp/i
const JITSUMORI_SUBJECT_MARKER = '数量報告'
function isJitsumoriQuantityReport(email) {
  return JITSUMORI_SENDER_RE.test(email.from || '') && (email.subject || '').includes(JITSUMORI_SUBJECT_MARKER)
}

// タスクタイトルのキーワード一致による返信先の絞り込み（フォームタスクの返信検知）で、
// ほぼ全てのタイトルに現れて識別力の無い定型語をノイズとして除外する。
const KEYWORD_STOPWORDS = new Set([
  '見積', '見積り', '見積書', '依頼', '発注', '発注書', '請求', '請求書', '納品', '納品書',
  '納期', '問合', '問合せ', '問い合わせ', 'お問い合わせ', '連絡', 'ご連絡', '確認', 'ご確認',
  '対応', '作成', '相談', 'ご相談', '案内', 'ご案内', '注文', '注文書',
])

// 分類器（Claude）に読ませる添付ファイルの対応 MIME と種別。
// PDF は document ブロック、主要な画像形式は image ブロックとして渡す。
// TIFF は Claude が非対応のため対象外（従来 FAX の TIFF はここに含めない）。
const CLASSIFY_DOC_TYPES = {
  'application/pdf': 'pdf',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
}
// 1ファイルあたりの上限（Claude の PDF 上限は 32MB。安全側で 10MB）。
const MAX_CLASSIFY_DOC_BYTES = 10 * 1024 * 1024
// 1メールで分類器に渡す添付の最大数と合計サイズ（コスト・リクエストサイズの保護）。
const MAX_CLASSIFY_DOCS = 5
const MAX_CLASSIFY_TOTAL_BYTES = 12 * 1024 * 1024

// Gmail の添付は base64url。Claude は改行なしの標準 base64 を要求するため変換する。
function base64urlToBase64(data) {
  let s = (data || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')
  const pad = s.length % 4
  if (pad) s += '='.repeat(4 - pad)
  return s
}

// メールの添付から、分類器に読ませる PDF/画像を集めて取得する。
// 対応形式・サイズ上限・件数上限でフィルタし、実体（base64）を取得して返す。
// FAX 転送メール（PDF/画像）や見積書・注文書などをそのまま Claude に読ませるために使う。
async function collectClassifierDocuments(accessToken, email) {
  const atts = email.attachments || []
  const docs = []
  let total = 0
  for (const a of atts) {
    if (docs.length >= MAX_CLASSIFY_DOCS) break
    const kind = CLASSIFY_DOC_TYPES[(a.mimeType || '').toLowerCase()]
    if (!kind) continue
    if (!a.attachmentId) continue
    if (a.size && a.size > MAX_CLASSIFY_DOC_BYTES) continue
    if (total + (a.size || 0) > MAX_CLASSIFY_TOTAL_BYTES) continue
    try {
      const { data, size } = await getAttachmentData(accessToken, email.id, a.attachmentId)
      if (!data) continue
      if (size && size > MAX_CLASSIFY_DOC_BYTES) continue
      total += size || 0
      if (total > MAX_CLASSIFY_TOTAL_BYTES) break
      const base64 = base64urlToBase64(data)
      if (kind === 'pdf') {
        docs.push({ type: 'pdf', data: base64, filename: a.filename })
      } else {
        // image/jpg は Claude 的には image/jpeg
        const mediaType = a.mimeType.toLowerCase() === 'image/jpg' ? 'image/jpeg' : a.mimeType.toLowerCase()
        docs.push({ type: 'image', mediaType, data: base64, filename: a.filename })
      }
    } catch {
      // 個別の添付取得失敗は無視して分類は継続する
    }
  }
  return docs
}

// 担当者を特定できないときに設定する既定値。
// 以前は先頭の担当者（橋口）を既定にしていたが、未判定であることを
// 画面上で警告表示できるよう、専用のプレースホルダーに変更した。
const UNASSIGNED = '（担当未設定）'

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
const EMAIL_RE_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

// 文字列から最初のメールアドレスを取り出す（"名前 <a@b.jp>" 形式にも対応）
function extractEmail(str) {
  const m = typeof str === 'string' ? str.match(EMAIL_RE) : null
  return m ? m[0] : null
}

// 文字列に含まれるメールアドレスをすべて小文字で取り出す（To/Cc の複数宛先用）
function extractEmails(str) {
  const m = typeof str === 'string' ? str.match(EMAIL_RE_G) : null
  return m ? m.map((s) => s.toLowerCase()) : []
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
    // 3つ以上連続する改行は空行1つ（改行2つ）に圧縮し、段落の区切りは保持する
    .replace(/\n{3,}/g, '\n\n')
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

  const summary = { fetched: 0, created: 0, replied: 0, updated: 0, nonBusiness: 0, errors: [], creditAlert: null }
  const logRows = []

  // Claude 利用量の集計とクレジット不足の検知
  let usageInput = 0
  let usageOutput = 0
  let classifyCalls = 0
  // FAX（添付PDF/画像の読取）はメールより入出力トークンが多く、将来的に上位モデルへ
  // 切り替える可能性があるため、内訳として別集計しておく（メール/フォームと合算しない）。
  let faxUsageInput = 0
  let faxUsageOutput = 0
  let classifyFaxCalls = 0
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

  // 診断用（2026-07-22）: メール取得が0件になる不具合の調査のため、以下を settings の
  // `_gmail_diag` 行にJSONで書き出し、Supabaseから直接読めるようにする（Cloudflare
  // ログを読まずに済ませるため）。原因判明後に削除予定。
  //  - profile: Workerのトークンが実際に見ているメールボックスのアドレスと総数
  //  - probe: last_fetch_atに依存しない固定クエリ `in:inbox newer_than:2d` の件数
  //    （実際のクエリが0件でも、受信箱そのものが見えているかを切り分けるため）
  try {
    const diag = { at: new Date().toISOString(), actualQuery: query, actualCount: messageRefs.length }
    try {
      const profile = await getProfile(accessToken)
      diag.profile = {
        emailAddress: profile.emailAddress,
        messagesTotal: profile.messagesTotal,
        threadsTotal: profile.threadsTotal,
      }
    } catch (e) {
      diag.profileError = String(e.message || e)
    }
    try {
      const probeRefs = await listMessageIds(accessToken, 'in:inbox newer_than:2d', 50)
      diag.probeQuery = 'in:inbox newer_than:2d'
      diag.probeCount = probeRefs.length
    } catch (e) {
      diag.probeError = String(e.message || e)
    }
    await supabase.from('settings').upsert({ key: '_gmail_diag', value: JSON.stringify(diag) }, { onConflict: 'key' })
  } catch (err) {
    console.error('gmail 診断の記録に失敗:', err)
  }

  // 既にDBにあるスレッドはスキップ
  const { data: existingRows } = await supabase.from('tasks').select('gmail_thread_id')
  const existingThreads = new Set((existingRows || []).map((r) => r.gmail_thread_id))
  const processedThreads = new Set()

  const context = { assignees, orgContext, businessKeywords, today: todayJST() }

  // 未処理タスクの一覧（件名ベースの返信検知用）。
  // 担当者が自分のメーラーから返信すると References ヘッダーが付かず
  // 元スレッドに紐付かないことがあるため、件名の一致でも返信を検知する。
  // 未処理タスクに加えて「返信済み」タスクも対象にする。返信済みのタスクに
  // さらに新しい返信が来た場合、本文を最新の返信で上書きするため。
  const { data: openTaskRows } = await supabase
    .from('tasks')
    .select(
      'id, status, gmail_thread_id, gmail_message_id, title, subject, sender, sender_email, channel, body_preview, classification_note, last_reply_message_id'
    )
    .in('status', ['未処理', '返信済み'])
    .eq('source', 'email')
  // 件名 → タスクの対応表。同じ件名に未処理と返信済みが併存する場合は未処理を優先する
  // （初回の返信検知を、返信済みの上書き検知より優先させるため）。
  const openBySubject = new Map()
  for (const t of openTaskRows || []) {
    if (t.status === '返信済み') openBySubject.set(normalizeSubject(t.subject), t)
  }
  for (const t of openTaskRows || []) {
    if (t.status === '未処理') openBySubject.set(normalizeSubject(t.subject), t)
  }

  // 顧客メールアドレス → 未処理のフォーム経由タスク一覧（フォームタスクの返信検知用）。
  // 問い合わせフォームの自動送信メールは件名が定型（例:「ホームページからのお問い合わせ」）で
  // 全顧客共通のため、件名ベースの検知（openBySubject）が使えない。フォーム本文から抽出した
  // 顧客の実アドレス（sender_email）で代わりに引き当てる。
  const openFormByEmail = new Map()
  for (const t of openTaskRows || []) {
    if (t.status !== '未処理' || t.channel !== 'form' || !t.sender_email) continue
    const key = t.sender_email.toLowerCase()
    const list = openFormByEmail.get(key)
    if (list) list.push(t)
    else openFormByEmail.set(key, [t])
  }

  // タイトルからキーワードを粗く抽出する（形態素解析は行わない簡易ヒューリスティック）。
  // カタカナ・漢字・英数字それぞれの連続をトークンとして分け、ひらがな（助詞・活用語尾）は
  // 区切りとして無視することで「ランプシェード」「見積作成」のような名詞の塊を拾いやすくする。
  // ひらがな・カタカナ・漢字をまとめて1トークンにすると「見積り依頼」のような文全体が
  // 1語になってしまい、部分一致しなくなるため分けている。
  function extractTitleKeywords(title) {
    const text = String(title || '')
    const katakana = text.match(/[ァ-ヶー]{2,}/g) || []
    const kanji = text.match(/[一-龠]{2,}/g) || []
    const alnum = text.match(/[a-zA-Z0-9]{2,}/g) || []
    return [...katakana, ...kanji, ...alnum].filter((k) => !KEYWORD_STOPWORDS.has(k))
  }

  // 同じ顧客メールアドレスに複数の未処理フォームタスクがある場合、新しいメールの件名・
  // 本文とタスクタイトルのキーワード一致で1件に絞り込む。一致が無い、または複数タスクで
  // 同点の場合は誤って結び付けないよう自動判定を見送る（null を返す）。
  function pickFormReplyTarget(candidates, emailText) {
    if (candidates.length === 1) return candidates[0]
    let best = null
    let bestScore = 0
    let tied = false
    for (const task of candidates) {
      const score = extractTitleKeywords(task.title).filter((k) => emailText.includes(k)).length
      if (score === 0) continue
      if (score > bestScore) {
        best = task
        bestScore = score
        tied = false
      } else if (score === bestScore) {
        tied = true
      }
    }
    return tied ? null : best
  }

  // 返信を検知したタスクを更新する（返信検知の共通処理）。
  // - 未処理タスク: ステータスを「返信済み」にし、本文を返信内容へ置き換える（初回検知）。
  //   元のメール内容は返信内の引用として残っている想定。
  // - 既に返信済みのタスク: さらに新しい返信が来たケース。ステータスは「返信済み」のまま
  //   本文だけを最新の返信で上書きする。既に取り込み済みの返信（本文が同一）は何もしない。
  // reply には返信メール（getMessage の結果）を渡す。
  // 冪等化のため、取り込んだ返信の message id を last_reply_message_id に記録する。
  async function incorporateReply(task, via, reply = null) {
    const newBody = reply && reply.body ? compactBody(reply.body).slice(0, MAX_BODY_PREVIEW) : null
    const replyId = reply ? reply.id : null

    // --- 既に返信済みのタスクへの、さらなる返信（本文の上書き） ---
    if (task.status === '返信済み') {
      // 同じ返信を再検知しただけ（本文が変わらない）なら、毎サイクルの再適用を避けるため
      // last_reply_message_id だけ静かに控えて終了する（ログも件数も増やさない）。
      if (!newBody || newBody === task.body_preview) {
        if (replyId && replyId !== task.last_reply_message_id) {
          await supabase.from('tasks').update({ last_reply_message_id: replyId }).eq('id', task.id)
        }
        return false
      }
      const note = `【返信更新】${via}（差出人: ${reply.from || '不明'}）。さらに新しい返信を受信したため、本文を最新の内容に置き換えました。`
      const { error } = await supabase
        .from('tasks')
        .update({
          body_preview: newBody,
          last_reply_message_id: replyId,
          classification_note: task.classification_note ? `${task.classification_note}\n${note}` : note,
        })
        .eq('id', task.id)
        .eq('status', '返信済み')
      if (error) return false
      summary.updated += 1
      logRows.push({
        log_type: 'status_change',
        actor: 'システム（自動）',
        message: `「${task.title}」を最新の返信で更新（${via}・返信済みのまま本文を上書き）`,
        detail: { task_id: task.id },
      })
      return true
    }

    // --- 未処理 → 返信済み（初回の返信検知） ---
    const fields = { status: '返信済み', last_reply_message_id: replyId }
    if (newBody) {
      fields.body_preview = newBody
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
          await incorporateReply(openTask, '返信を検知', email)
          continue
        }
      }

      // フォーム経由タスクの返信検知（顧客メールアドレス一致）: 上記の件名ベース検知は
      // フォームの定型件名では機能しないため、当社担当者から顧客の実アドレス
      // （sender_email）宛に送られたメールを返信とみなす。同じ顧客に複数の未処理
      // フォームタスクがある場合は、タイトルのキーワードとメール内容の一致で絞り込み、
      // 絞り込めなければ自動判定を見送る（誤って別件に結び付けない）。
      if (isCompanyAddress(fromEmail) && openFormByEmail.size > 0) {
        const recipients = extractEmails(`${email.to || ''} ${email.cc || ''}`)
        const emailText = `${email.subject || ''}\n${email.body || ''}`
        let formTask = null
        for (const addr of recipients) {
          const candidates = openFormByEmail.get(addr.toLowerCase())
          if (!candidates || !candidates.length) continue
          formTask = pickFormReplyTarget(candidates, emailText)
          if (formTask) break
        }
        if (formTask && email.id !== formTask.gmail_message_id) {
          await incorporateReply(formTask, 'フォームタスクへの返信を検知（顧客メールアドレス一致）', email)
          // 解決したタスクだけを候補から外す（同じ顧客の他の未処理タスクは残す）
          const key = formTask.sender_email.toLowerCase()
          const remaining = (openFormByEmail.get(key) || []).filter((t) => t.id !== formTask.id)
          if (remaining.length) openFormByEmail.set(key, remaining)
          else openFormByEmail.delete(key)
          continue
        }
      }

      if (existingThreads.has(email.threadId) || processedThreads.has(email.threadId)) continue
      processedThreads.add(email.threadId)

      // 添付（PDF/画像）があれば分類器に読ませる。FAX 転送メールや見積書等に対応。
      let documents = []
      try {
        documents = await collectClassifierDocuments(accessToken, email)
      } catch (err) {
        summary.errors.push(`attachment: ${String(err.message || err)}`)
      }

      const { classification: result, usage } = await classifyEmail(email, context, documents)
      usageInput += usage.input_tokens
      usageOutput += usage.output_tokens
      classifyCalls += 1
      if (result.channel === 'fax') {
        faxUsageInput += usage.input_tokens
        faxUsageOutput += usage.output_tokens
        classifyFaxCalls += 1
      }

      // カード・詳細画面のアイコン表示用（メール/フォーム/FAX の区別）。
      // 分類できない・想定外の値は既定の "email" にする。
      // フォームの自動送信メールは定型文で確実に判定できるため、Claude の
      // 判定結果より優先する（分類漏れで "email" になるのを防ぐ）。
      const channel = isFormSubmission(email)
        ? 'form'
        : CHANNEL_VALUES.has(result.channel)
          ? result.channel
          : 'email'

      // FAXの読み取り失敗（ハルシネーション対策）: 添付の判読に自信が持てない場合、
      // Claudeは document_readable=false を返す（プロンプトで明示的に禁止しているため、
      // このときの他フィールドは信頼できない＝会社名・金額などを創作している恐れがある）。
      // 誤った情報でタスクを作らず、タイトルに読み取り失敗を明記して人が添付を直接
      // 確認できるようにする。is_business_task の判定自体も読み取り失敗時は信頼できない
      // ため、判定によらず必ずタスク化する。
      const isFax = channel === 'fax'
      const isFaxReadFailure = isFax && result.document_readable === false

      // FAXは業務外(is_business_task=false)判定でも必ずタスク化する（2026-07-22）。
      // 調査中、本日08:51着のFAX（読み取り自体は失敗していない=document_readable）が
      // is_business_task=false と判定され、タスクにも操作ログにも痕跡を残さず
      // 静かに捨てられていた事象を発見した（該当FAXが実際に業務用件だったかは未確認だが、
      // 少なくとも人が気づける手段が一切無いのは望ましくない）。FAXはメール全般と違って
      // 件数が少なく誤検知の実害（無関係なタスクが1件増える程度）が小さい一方、
      // 見落としの実害（顧客対応漏れ）が大きいため、通常メールとは異なり判定によらず
      // 必ずタスク化する方針にする（読み取り失敗時と同様の扱い）。
      const isFaxNonBusinessOverride = isFax && !isFaxReadFailure && !result.is_business_task

      const isJitsumoriReport = isJitsumoriQuantityReport(email)

      if (!isFax && !isJitsumoriReport && !result.is_business_task) {
        summary.nonBusiness += 1
        continue
      }

      // 担当者の正規化（不明・範囲外は「（担当未設定）」にして画面で警告表示させる）。
      // 實守紙業の数量報告はorg_contextのルールにより西川固定のため、Claudeが
      // 正しく割り当てられなかった場合のフォールバックとして西川を優先する。
      let assignee = isFaxReadFailure ? null : result.assignee
      if (isJitsumoriReport && (!assignee || !assignees.includes(assignee))) assignee = '西川'
      if (!assignee || !assignees.includes(assignee)) assignee = UNASSIGNED

      const dueDate = !isFaxReadFailure && typeof result.due_date === 'string' && DUE_RE.test(result.due_date)
        ? result.due_date
        : null

      // 添付（FAX/PDF/画像）から Claude が読み取った要約。title を先に必要とするため
      // ここで計算する（本文用の再利用は下記 docSummary 参照箇所を参照）。
      const docSummary =
        !isFaxReadFailure && typeof result.document_summary === 'string' && result.document_summary.trim()
          ? result.document_summary.trim()
          : null

      // Claude が title を埋めなかった場合の保険。特に「業務外」判定のFAX等で
      // title が空のまま email.subject（FAX共通の定型件名「Attached Image」等）に
      // フォールバックし、内容が分かるのに意味の無いタイトルになる事例があったため、
      // document_summary の冒頭から簡潔な代替タイトルを組み立てる。
      const fallbackTitleFromSummary = docSummary
        ? (() => {
            const firstSentence = docSummary.split(/[。\n]/)[0].trim()
            if (!firstSentence) return null
            return firstSentence.length > 30 ? `${firstSentence.slice(0, 30)}…` : firstSentence
          })()
        : null

      const title = isFaxReadFailure
        ? '（FAX内容の読み取り失敗）'
        : (
            (typeof result.title === 'string' && result.title.trim()) ||
            fallbackTitleFromSummary ||
            email.subject ||
            '（件名なし）'
          ).slice(0, 120)

      // 自社の社員が社外の宛先へ新規に送ったメールは、こちらから既に連絡済みのため
      // 初めから「返信済み」で登録する。差出人が自社（共有アドレス/自社ドメイン）かつ
      // 宛先(To/Cc)に社外アドレスを含むものが該当する。
      // フォーム経由の問い合わせ（差出人は自社ドメインだが宛先は共有アドレス=社内）は
      // 社外宛先を含まないため対象外になる。
      const recipientEmails = extractEmails(`${email.to || ''} ${email.cc || ''}`)
      const isOutbound =
        isCompanyAddress(fromEmail) && recipientEmails.some((a) => !isCompanyAddress(a))
      const initialStatus = isOutbound ? '返信済み' : '未処理'

      // 送信元の会社・氏名（Claude が件名/本文から抽出。フォーム経由は本文優先）。
      // FAX読み取り失敗時は添付から抽出した情報が信頼できないため使わない。
      const senderDisplay =
        !isFaxReadFailure && typeof result.sender_display === 'string' && result.sender_display.trim()
          ? result.sender_display.trim().slice(0, 120)
          : null

      // 先方担当者の宛名（会社・氏名＋様。返信メールの冒頭に使う）。
      // Claude が抽出できなければ sender_display に「様」を付けてフォールバックする。
      const contact =
        !isFaxReadFailure && typeof result.contact === 'string' && result.contact.trim()
          ? result.contact.trim().slice(0, 120)
          : senderDisplay
            ? `${senderDisplay} 様`
            : null

      // 返信先アドレス: Claude の抽出（フォーム経由は本文のアドレス）を優先し、
      // 無ければ Reply-To → From の順にフォールバック
      const senderEmail = isFaxReadFailure
        ? extractEmail(email.replyTo) || extractEmail(email.from)
        : extractEmail(result.sender_email) || extractEmail(email.replyTo) || extractEmail(email.from)

      // docSummary は title の直前で計算済み（FAX 転送メールは本文がほぼ無いため、
      // この要約を本文としても表示する。通常メールで本文もある場合は本文の後ろに
      // 添付内容を追記する。FAX読み取り失敗時は要約自体が信頼できないため使わず、
      // 失敗理由を代わりに表示する）。
      const emailBody = compactBody(email.body)
      // FAXゲートウェイの本文は FROM=/TO=/DATE=/TIME=/TIMEZONE=/FCODE=/RJOBNUM= という
      // 受信情報のみで業務内容を含まない。このうち RJOBNUM（受信ジョブ番号。複合機側で
      // 受信書類を特定する際に使う）だけは残す価値があるため、FAXの場合は本文全体では
      // なくこの行だけを抽出して使う。
      const faxJobNumberLine = isFax ? (email.body || '').match(/^RJOBNUM=.*/m)?.[0]?.trim() || null : null
      let bodyPreview
      if (isFaxReadFailure) {
        const issue =
          typeof result.document_read_issue === 'string' && result.document_read_issue.trim()
            ? result.document_read_issue.trim()
            : '添付の画質が不十分などの理由で内容を判読できませんでした'
        bodyPreview = `【FAXの内容を読み取れませんでした】\n理由: ${issue}\n\n添付のFAX画像/PDFを直接ご確認ください。`
      } else if (isFax) {
        bodyPreview = docSummary
          ? [faxJobNumberLine, `【添付資料の内容（自動読取）】\n${docSummary}`].filter(Boolean).join('\n\n')
          : faxJobNumberLine || emailBody
      } else if (docSummary) {
        bodyPreview =
          emailBody && emailBody.length > 20
            ? `${emailBody}\n\n──────────\n【添付資料の内容（自動読取）】\n${docSummary}`
            : `【添付資料の内容（自動読取）】\n${docSummary}`
      } else {
        bodyPreview = emailBody
      }
      bodyPreview = bodyPreview.slice(0, MAX_BODY_PREVIEW)

      const outboundNote = isOutbound
        ? '自社から社外への新規送信メールのため、初めから「返信済み」で登録しました。'
        : null
      const docNote = docSummary && documents.length
        ? `添付${documents.length}件（PDF/画像）を読み取って内容を反映しました。`
        : null
      const faxFailureNote = isFaxReadFailure
        ? '添付の内容を自信を持って判読できなかったため、内容を推測せずタスク化しました。担当者は添付を直接確認してください。'
        : null
      const faxNonBusinessNote = isFaxNonBusinessOverride
        ? 'AIは業務外の可能性があると判定しましたが、FAXは見落とし防止のため必ずタスク化しています。内容をご確認のうえ、不要であれば完了にしてください。'
        : null
      const jitsumoriNote =
        isJitsumoriReport && !result.is_business_task
          ? 'AIは業務外と判定しましたが、實守紙業の数量報告は既知の業務メールのため必ずタスク化しています。'
          : null
      const classificationNote =
        [faxFailureNote, faxNonBusinessNote, jitsumoriNote, result.reason || null, outboundNote, docNote]
          .filter(Boolean)
          .join('\n') || null

      const { error: insertError } = await supabase.from('tasks').insert({
        gmail_thread_id: email.threadId,
        gmail_message_id: email.id,
        title,
        assignee,
        status: initialStatus,
        due_date: dueDate,
        sender: email.from || '（不明）',
        sender_display: senderDisplay,
        contact,
        sender_email: senderEmail,
        subject: email.subject || '（件名なし）',
        body_preview: bodyPreview,
        received_at: email.receivedAt || new Date().toISOString(),
        classification_note: classificationNote,
        channel,
      })

      if (insertError) {
        // 一意制約違反（既に取り込み済み）は無視。それ以外は記録。
        if (!/duplicate key|unique/i.test(insertError.message)) {
          summary.errors.push(`insert: ${insertError.message}`)
        }
      } else {
        summary.created += 1
        existingThreads.add(email.threadId)
        // 通知の失敗でパイプライン自体を止めないよう、ここでは投げない
        try {
          await notifyNewTask({ title })
        } catch (err) {
          console.error('push通知失敗:', err)
        }
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
    // 未処理に加えて「返信済み」タスクも対象にし、さらなる返信があれば本文を上書きする。
    const { data: openTasks } = await supabase
      .from('tasks')
      .select(
        'id, status, gmail_thread_id, gmail_message_id, title, subject, sender, sender_email, body_preview, classification_note, last_reply_message_id'
      )
      .in('status', ['未処理', '返信済み'])
      .eq('source', 'email')
    for (const task of openTasks || []) {
      try {
        const messages = await getThreadMessages(accessToken, task.gmail_thread_id)
        if (messages.length === 0) continue
        const originalFrom = (extractEmail(task.sender) || '').toLowerCase()
        // 顧客(counterpart)のアドレスを特定する。
        //  - 受信メール由来のタスク（sender が顧客）: 元の送信者が顧客
        //  - 自社発信由来のタスク（sender が自社）: 元メッセージの宛先(To/Cc)のうち
        //    自社以外が顧客（例: 自社→社外への送信で「返信済み」登録されたタスク）
        let counterpart = ''
        if (isCompanyAddress(originalFrom)) {
          const orig = messages.find((m) => m.id === task.gmail_message_id)
          const recips = orig ? extractEmails(`${orig.to || ''} ${orig.cc || ''}`) : []
          counterpart = recips.find((a) => !isCompanyAddress(a)) || ''
        } else {
          const se = (task.sender_email || '').toLowerCase()
          counterpart = se && !isCompanyAddress(se) ? se : originalFrom
        }
        // 顧客を特定できない場合は安全側で何もしない（誤上書き防止）
        if (!counterpart) continue
        // スレッド内で最も新しい「自社発」メッセージを返信とみなす。顧客が受領返信を
        // 最後に送っていても、担当者（自社）の最新の更新返信をタスクに反映できるようにする。
        // ガード:
        //  - 自社発（共有アドレス or 自社ドメイン）であること
        //  - タスク登録の元メール自体は除外
        //  - 宛先(To/Cc)に顧客(counterpart)を含むこと（同一件名で複数顧客が
        //    スレッドにまとまる場合の混線防止。正当な返信は必ず顧客宛て）
        let reply = null
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          const from = (extractEmail(m.from) || '').toLowerCase()
          if (!isCompanyAddress(from)) continue
          if (m.id === task.gmail_message_id) continue
          const recipients = `${m.to || ''} ${m.cc || ''}`.toLowerCase()
          if (!recipients.includes(counterpart)) continue
          reply = m
          break
        }
        if (!reply) continue
        // 既に取り込んだ返信と同じなら、本文の再取得もせずスキップする
        // （返信済みタスクを毎サイクル走査するため、同じ返信の再適用・コスト増を防ぐ）。
        if (reply.id === task.last_reply_message_id) continue
        // 返信の本文でタスク詳細を更新するため、対象メッセージ全体を取得する
        const replyEmail = await getMessage(accessToken, reply.id)
        await incorporateReply(task, 'スレッドで返信を検知', replyEmail)
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
          // 詳細に「担当：〜」があれば担当者に採用。無ければ「（担当未設定）」
          const assignee = extractCalendarAssignee(desc) || UNASSIGNED
          const { error: calErr } = await supabase.from('tasks').insert({
            gmail_thread_id: key,
            gmail_message_id: ev.id,
            source: 'calendar',
            channel: 'calendar',
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
            try {
              await notifyNewTask({ title: ev.title || '（無題の予定）' })
            } catch (err) {
              console.error('push通知失敗:', err)
            }
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
      p_fax_calls: classifyFaxCalls,
      p_fax_input: faxUsageInput,
      p_fax_output: faxUsageOutput,
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

  summary.usage = {
    input_tokens: usageInput,
    output_tokens: usageOutput,
    calls: classifyCalls,
    fax_calls: classifyFaxCalls,
    fax_input_tokens: faxUsageInput,
    fax_output_tokens: faxUsageOutput,
  }

  // 5.5) 完了タスクのアーカイブ移行
  //   「完了」になってから archive_after_days 日を超えたタスクを archived_at に
  //   移して、カンバンの完了列に溜まり続けないようにする（アーカイブ画面で参照）。
  //   archive_after_days が 0 以下なら無効。completed_at が無い（旧データ）ものは対象外。
  summary.archived = 0
  const archiveAfterDays = Number(settings.archive_after_days)
  if (Number.isFinite(archiveAfterDays) && archiveAfterDays > 0) {
    const cutoff = new Date(Date.now() - archiveAfterDays * 86400000).toISOString()
    const { data: archivedRows, error: archiveError } = await supabase
      .from('tasks')
      .update({ archived_at: new Date().toISOString() })
      .is('archived_at', null)
      .eq('status', '完了')
      .not('completed_at', 'is', null)
      .lt('completed_at', cutoff)
      .select('id')
    if (archiveError) {
      summary.errors.push(`archive: ${archiveError.message}`)
    } else {
      summary.archived = archivedRows?.length || 0
    }
  }

  // 6) 操作ログの書き込み（取得サマリー + 自動ステータス変更）と古いログの削除
  const fetchMessage =
    `メール取得: 取得 ${summary.fetched} 件 / 新規タスク ${summary.created} 件 / ` +
    `返信検知 ${summary.replied} 件 / 返信更新 ${summary.updated} 件 / 業務外 ${summary.nonBusiness} 件 / ` +
    `カレンダー登録 ${summary.calendarCreated} 件 / アーカイブ ${summary.archived} 件` +
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
