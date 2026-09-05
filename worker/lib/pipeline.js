import { getAdminClient } from './supabase-admin.js'
import { getAccessToken, listMessageIds, getMessage, getThreadMessages, getAttachmentData } from './gmail.js'
import { resolveCalendar, listTodayEvents } from './calendar.js'
import { classifyEmail } from './anthropic.js'
import { notifyNewTask, notifyApiAlert } from './push.js'
import { checkDailyLimit, addTodayUsage, setLimitAlert, clearLimitAlert } from './usageLimit.js'
import { createSubrequestBudget } from './subrequests.js'

// 1回の取得で処理するメッセージ上限（コスト・実行時間の保護）
const MAX_MESSAGES = 40

// 1回の巡回で返信検知（スレッド読み取り）を行う進行中タスクの上限（2026-09-04）。
// 返信検知は「未処理・返信済み」のタスク1件につきGmailスレッドを1回読むため、
// タスクが増えるほどサブリクエストを食い、上限超過で後続の処理を巻き添えにする
// （9/3の事故。docs/HANDOFF.md 223番）。1回では全件を見ずに、前回の続きから
// 順に見ていく（settings.reply_check_cursor に進捗を残す）。数巡すれば全件を回るので、
// 検知が遅れるのは最大で「タスク件数 ÷ この値」巡ぶん。
const REPLY_CHECK_MAX_TASKS = 12

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

// FAXゲートウェイ（複合機）から転送されてくる受信メールか。分類器（Claude）を
// 通す前に、メール本文だけで確実に判定できる手掛かりで見分ける。用途は2つ:
//  (1) 重複判定をスレッド単位ではなくメッセージ単位にする（下記メインループ）。
//      FAXは全て同じ送信元・同じ定型件名（「Attached Image」）で届くため、Gmailが
//      連続して届いたFAXを1つの会話（スレッド）に束ねてしまい、スレッド単位だと
//      束ねられた2通目以降が「処理済みスレッド」扱いで捨てられる（2026-07-23、
//      14:42着FAXの見落としで判明）。
//  (2) channel を決定的に 'fax' に固定する（下記）。これによりClaudeのchannel判定に
//      依らず「FAXは業務外でも必ずタスク化」の保護が効く。
// 判定は送信元を主にする。全FAXは複合機の固定アドレス（FAX_GATEWAY_SENDER）から
// 届くため、これがもっとも確実。ヘッダ（From）はメール本文の抽出処理の影響を受けない。
// 補助として、本文にFAXゲートウェイ固有の「RJOBNUM=」（受信ジョブ番号）トークンを含む
// 場合もFAXと見なす（将来、転送元アドレスが変わっても本文で拾えるように）。
// ※当初は本文の行頭一致（/^RJOBNUM=/m）だけで判定していたが、メール本文の抽出結果は
// 経路（text/plain / HTMLからのタグ除去 / snippetフォールバック）により内容が想定と
// 変わることがあり、RJOBNUM文字列を含まない本文になってFAXを取りこぼした（2026-07-23、
// 14:42着FAXの再取得で判明。本文依存の判定は脆いと判断し、送信元判定を主にした）。
const FAX_GATEWAY_SENDER = 'mimi@eiwa-up.com'
const FAX_GATEWAY_RE = /RJOBNUM=/i
function isFaxGatewayEmail(email) {
  return (email.from || '').toLowerCase().includes(FAX_GATEWAY_SENDER) || FAX_GATEWAY_RE.test(email.body || '')
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
  // 更新間隔ゲート専用の時刻（2026-09-04）。last_fetch_at とは役割が違うので混同しないこと。
  //   last_fetch_at … 取得クエリの窓（after:）。**最後まで完走したときだけ**前進させる。
  //                    途中で落ちた実行で前進させると、そのメールを永久に取りこぼす
  //                    （anthropic.js 冒頭の 2026-07-27 の事例を参照）。
  //   last_run_at   … 実行間隔の抑制のみに使う。**Claude を呼ぶ前に必ず記録する**ので、
  //                    実行が途中で落ちても次の cron 刻みはゲートで止まる。
  // 両者を分けた経緯は 9/3 の課金事故（docs/ai-cost-and-alternatives.md 9章「原因B」）。
  // 当時はゲートも last_fetch_at を見ていたため、手順7に到達できない実行が続くと
  // 経過時間が常に間隔を超え、ゲートが素通りして cron の 5 分間隔がそのまま実行間隔に
  // なっていた（1日19回 → 約120回）。
  const lastRunAt = settings.last_run_at ? new Date(settings.last_run_at) : null
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

  // 更新間隔ゲート（スケジュール実行時のコスト抑制）。
  // 判定は last_run_at（実行を開始した時刻）で行う。last_fetch_at で判定すると、
  // 完走できない実行が続いたときにゲートごと外れてしまうため（上のコメント参照）。
  // last_run_at がまだ無い場合だけ last_fetch_at にフォールバックする。
  const gateBase = lastRunAt || lastFetchAt
  if (!force && gateBase && Number.isFinite(gateBase.getTime())) {
    const elapsedMin = (Date.now() - gateBase.getTime()) / 60000
    if (elapsedMin < intervalMin) {
      return { skipped: true, reason: `前回実行から${Math.round(elapsedMin)}分（間隔${intervalMin}分）`, created: 0 }
    }
  }

  // ゲートを通過したらすぐ last_run_at を記録する。**Claude 呼び出しより前**に置くこと。
  // ここから先で実行が落ちても、次の cron 刻みは上のゲートで止まる（暴走の上限を
  // 「間隔あたり1回」に固定する）。記録に失敗したときは抑制が効かなくなるため、
  // 安全側に倒してこの回の実行自体を見送る。
  {
    const { error: runMarkError } = await supabase
      .from('settings')
      .upsert({ key: 'last_run_at', value: new Date().toISOString() }, { onConflict: 'key' })
    if (runMarkError) {
      console.error('last_run_at の記録に失敗:', runMarkError.message)
      return { skipped: true, reason: `last_run_at の記録に失敗: ${runMarkError.message}`, created: 0 }
    }
  }

  const summary = { fetched: 0, created: 0, replied: 0, updated: 0, nonBusiness: 0, errors: [], creditAlert: null }
  const logRows = []

  // サブリクエスト（1回のWorker呼び出しで出せる外部リクエスト）の予算（2026-09-04）。
  // 上限に当たってから個別のエラーを拾うのではなく、残りが尽きる前に重い処理を
  // 打ち切って、末尾の記録処理（利用量・操作ログ・last_fetch_at）を必ず通す。
  // 経緯は worker/lib/subrequests.js の冒頭を参照。
  const budget = createSubrequestBudget(settings.subrequest_limit)
  // ここまでで使ったぶん（settings取得・last_run_at記録・停止判定の読み取り）と、
  // この直後に出す固定の呼び出し（アクセストークン・一覧取得・tasks/processed_messages
  // の読み取り）を概算で計上しておく。
  budget.use(8)
  // 予算切れで積み残した処理（画面・ログに出して気づけるようにする）
  const deferred = { mail: 0, replyCheck: 0, calendar: false }

  // 取得窓の凍結検知（2026-09-04）。
  // last_run_at（実行を開始した時刻・Claude呼び出し前に必ず記録）と
  // last_fetch_at（最後まで完走したときだけ前進）を突き合わせる。前者が後者より
  // 大きく先行していたら「実行は来ているのに完走していない」＝どこかで落ち続けて
  // いる、と稼働時間に依存せず判定できる（稼働時間外の空白では両方が同じだけ
  // 古くなるので、差は開かない）。
  //
  // 放置すると取得窓が固定されたまま新着が溜まり続け（MAX_MESSAGES で頭打ちになり
  // 取りこぼす）、業務外メールの判定漏れのようなバグがあれば同じメールへの
  // Claude呼び出しを繰り返す。9/3の課金事故はこれに丸一日気づけなかったことで
  // 被害が広がったので、赤字の error ログで画面に出す。
  //
  // ログは logRows に積まずに**その場で書く**。logRows の挿入は手順6にあり、
  // ここで検知したいのは「手順6・7まで到達できていない」状態そのものなので、
  // 末尾にまとめて書く方式では肝心のときに残らない。
  // 連続実行のたびに赤い行が増えるのを避けるため、通知は1日1回に絞る
  // （クレジット不足・上限到達の通知と同じ考え方）。
  if (
    lastRunAt &&
    lastFetchAt &&
    Number.isFinite(lastRunAt.getTime()) &&
    Number.isFinite(lastFetchAt.getTime())
  ) {
    const behindMin = (lastRunAt.getTime() - lastFetchAt.getTime()) / 60000
    if (behindMin >= intervalMin * 2) {
      const message =
        `メール取得が最後まで完了していません（実行は${Math.round(behindMin)}分ぶん進んでいるのに、` +
        `取得の進捗が更新されていません）。同じメールの再取得・再分類が繰り返されている可能性が` +
        `あるため、Cloudflare Workers のログを確認してください。`
      summary.errors.push(message)
      const today = todayJST()
      if (settings.fetch_stall_alert_on !== today) {
        await supabase.from('activity_logs').insert({ log_type: 'error', actor, message })
        await supabase
          .from('settings')
          .upsert({ key: 'fetch_stall_alert_on', value: today }, { onConflict: 'key' })
      }
    }
  }

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

  // サーキットブレーカー（2026-09-04）。本日のAI利用額が上限に達していたら、
  // メールの取得自体は行うが分類（Claude呼び出し）は一切行わない。
  // 上限は設定画面の「AI利用の1日あたり上限」で変更できる。
  let limitState = await checkDailyLimit(supabase, settings.daily_api_cost_limit_usd)
  if (limitState.exceeded) {
    summary.errors.push(limitState.message)
    await setLimitAlert(supabase, limitState.message)
  }

  const accessToken = await getAccessToken()

  // 1) 新着メールの取得クエリを組み立てる
  // 迷惑メール（Gmailの自動スパム判定）も対象に含める（2026-08-24）。
  // あおば薬局からの返信がGmail側でスパム判定され、業務外判定（AI）以前の問題として
  // 自動取得の対象から漏れていた事例を受けての対応。誤って迷惑メールに振り分けられた
  // 本物の業務メールも同じ「業務外」AI分類を通るため、実際の迷惑メールがそのままタスク化
  // される心配は無い（分類コストは増えるが、現状の件数であれば許容範囲とユーザー確認済み）
  let query = '{in:inbox in:spam}'
  if (lastFetchAt) {
    query += ` after:${Math.floor(lastFetchAt.getTime() / 1000)}`
  } else {
    // 初回は直近1日分だけを対象にする（過去の大量メールを一気に取り込まない）
    query += ' newer_than:1d'
  }

  const messageRefs = await listMessageIds(accessToken, query, MAX_MESSAGES)
  summary.fetched = messageRefs.length
  // Gmail APIは新しい順に返すため、古い順に処理する。同一スレッドの元メールと返信が
  // 同じ取得サイクルに入った場合、新しい方（＝返信）が先にタスク化され、後から来た
  // 元メールは「同一スレッド処理済み」でスキップされてしまう。その結果、送信者が
  // 自社担当者のタスクができ、返信も反映されない状態になっていた（2026-08-03。T-88の事例）。
  // 古い順なら顧客の元メールがタスクになり、後続の自社発は返信として正しく扱える。
  messageRefs.reverse()

  // 既にDBにあるスレッドはスキップ（通常メール用のスレッド単位の重複判定）。
  // FAXは同一件名・同一送信元でGmailに束ねられるため、スレッドではなく
  // メッセージ単位で重複判定する。そのため gmail_message_id も取得しておく。
  //
  // 2026-08-17: スレッド単位の判定は「進行中（未処理/返信済み）」のタスクがあるスレッドに
  // 限定した。件名の使い回し（例: 毎月同じ件名で送る設備点検の案内、同じ件名で複数の
  // 別宛先に送る一斉連絡）でGmailが本来無関係な複数の用件を1スレッドに束ねることがあり、
  // 従来はスレッドに1件でもタスクがあれば（完了済みでも）後続メールを無条件でスキップして
  // いたため、既に完了したタスクの陰に別の新しい用件が隠れて取りこぼされる事例が実際に
  // 3件発生した（T-134/T-137/T-138。手動復旧して発覚）。完了/アーカイブ済みタスクしか
  // 無いスレッドは「進行中の会話」ではないとみなし、後続メールを独立した用件として
  // 分類し直せるようにする。**進行中のタスクがあるスレッドは従来どおりスキップする**
  // （同じ相手との普通の往復メールが件名一致の返信検知をすり抜けた場合の保険として、
  // スレッド単位の抑止は残す。安易にメッセージ単位のみに倒すと、返信検知が拾えなかった
  // 通常の返信メールが毎回スプリアスな新規タスクを作ってしまう恐れがあるため）
  const { data: existingRows } = await supabase.from('tasks').select('gmail_thread_id, gmail_message_id, status')
  const existingThreads = new Set(
    (existingRows || [])
      .filter((r) => r.status === '未処理' || r.status === '返信済み')
      .map((r) => r.gmail_thread_id)
  )
  const existingMessages = new Set((existingRows || []).map((r) => r.gmail_message_id))
  const processedThreads = new Set()
  const processedMessages = new Set()

  // 業務外と判定済みのメッセージ（2026-09-04）。タスクを作らないメールは tasks に
  // gmail_message_id が残らないため、これが無いと取得クエリに入り続ける限り毎回
  // 再分類され、添付PDF/画像を毎回 Claude へ再送信してAPIクレジットを浪費する
  // （実際に9/3-9/4で平常の約20倍のコストが発生した。docs/HANDOFF.md 219番）。
  const { data: judgedRows } = await supabase.from('processed_messages').select('gmail_message_id')
  const judgedMessages = new Set((judgedRows || []).map((r) => r.gmail_message_id))

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

  // 顧客（社外）からの返信を取り込み、タスクを「未処理」に戻す。
  // 自社が送信した内容でタスクが「返信済み」になっている状態に顧客から返答が来た場合、
  // 次に動くべきは自社なので、本文を顧客の返信内容へ置き換えたうえで status を
  // 「未処理」に戻して対応漏れを防ぐ（2026-07-29追加。従来は自社発メッセージのみを
  // 返信として扱っていたため、顧客からの返答が一切反映されず見落としになっていた）。
  // 完了・対応中のタスクは人が意図して設定した状態なので触らない（未処理/返信済みのみ対象）。
  async function incorporateCustomerReply(task, via, reply) {
    const newBody = reply && reply.body ? compactBody(reply.body).slice(0, MAX_BODY_PREVIEW) : null
    const replyId = reply ? reply.id : null
    if (!newBody) {
      if (replyId && replyId !== task.last_reply_message_id) {
        await supabase.from('tasks').update({ last_reply_message_id: replyId }).eq('id', task.id)
      }
      return false
    }
    const note = `【顧客からの返信】${via}（差出人: ${reply.from || '不明'}）。本文を顧客の返信内容に置き換え、対応が必要なためステータスを未処理に戻しました。`
    const { error } = await supabase
      .from('tasks')
      .update({
        status: '未処理',
        body_preview: newBody,
        last_reply_message_id: replyId,
        classification_note: task.classification_note ? `${task.classification_note}\n${note}` : note,
      })
      .eq('id', task.id)
      .in('status', ['未処理', '返信済み'])
    if (error) return false
    summary.updated += 1
    logRows.push({
      log_type: 'status_change',
      actor: 'システム（自動）',
      message: `「${task.title}」に顧客からの返信を検知し、ステータスを ${task.status} → 未処理 に変更（${via}）`,
      detail: { task_id: task.id },
    })
    return true
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
  let mailTruncated = false
  // 処理を終えた最後のメールの受信時刻。予算切れで途中打ち切りになったとき、
  // 取得窓（last_fetch_at）をここまで進めて残りを次の巡回に回す（手順7）。
  let lastProcessedReceivedAt = null
  for (const [refIndex, ref] of messageRefs.entries()) {
    try {
      // 既にタスク化済み・業務外と判定済みのメッセージは、**本文を取りに行く前に**
      // 打ち切る（2026-09-04）。従来は getMessage の後に判定していたため、取得窓に
      // 残っている処理済みメールのぶんだけ毎回Gmailを叩き、サブリクエストを浪費して
      // いた（40通あれば40回。上限50の大半をここで使い切る）。判定材料は
      // メッセージIDだけなので、取得前に判定できる。
      if (existingMessages.has(ref.id) || judgedMessages.has(ref.id)) continue

      // 予算の残りが少なければ、ここで打ち切って残りは次の巡回に回す。
      // 1通あたり「本文取得＋添付＋分類＋DB書き込み」で概ね5回ぶん使う。
      if (!budget.has(5)) {
        mailTruncated = true
        deferred.mail = messageRefs
          .slice(refIndex)
          .filter((r) => !existingMessages.has(r.id) && !judgedMessages.has(r.id)).length
        break
      }

      const email = await getMessage(accessToken, ref.id)
      budget.use(1)
      // 取得できた時点で「このメールまでは見た」と記録する。メッセージは古い順に
      // 処理するので、この値は単調に進む。
      if (email.receivedAt) lastProcessedReceivedAt = email.receivedAt
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

      // 重複判定。このメッセージ自体が既にタスク化済みなら、タスクの状態を問わず常に
      // スキップする（メッセージ単位。全チャネル共通の一次判定）。
      // FAXは同一件名・同一送信元でGmailが別々のFAXを1スレッドに束ねるため、スレッド単位の
      // 判定は行わずここで終える（送信元が自社ドメイン外のため上の件名/フォーム返信検知にも
      // 掛からない）。通常メールはさらにスレッド単位でも判定するが、対象は existingThreads
      // （＝進行中＝未処理/返信済みのタスクを持つスレッドのみ。完了/アーカイブ済みタスクしか
      // 無いスレッドは対象外）に限定しており、完了済みタスクの陰に別件が隠れて取りこぼされる
      // のを防ぐ（2026-08-17。上記 existingThreads の構築箇所のコメント参照）。
      if (existingMessages.has(email.id) || processedMessages.has(email.id)) continue
      // 過去に業務外と判定済みのメールは、添付の取得も分類（Claude呼び出し）も行わずに
      // 打ち切る。**この判定は必ず collectClassifierDocuments / classifyEmail より前に
      // 置くこと**（後ろに置くと課金が発生してしまい、この修正の意味が無くなる）。
      if (judgedMessages.has(email.id)) continue
      processedMessages.add(email.id)
      if (!isFaxGatewayEmail(email)) {
        if (existingThreads.has(email.threadId) || processedThreads.has(email.threadId)) continue
        processedThreads.add(email.threadId)
      }

      // 本日の上限に達していたら、ここから先（添付の取得・Claudeでの分類）は行わない。
      // **添付の取得より前に置くこと**（後ろに置くと課金は止まってもGmailの通信は続く）。
      // 取得済みメールは判定済みとして記録しないため、上限が解除された翌日以降に
      // 改めて分類される（取りこぼしにはならない）。
      if (limitState.exceeded) continue

      // 添付（PDF/画像）があれば分類器に読ませる。FAX 転送メールや見積書等に対応。
      let documents = []
      try {
        documents = await collectClassifierDocuments(accessToken, email)
        budget.use(documents.length)
      } catch (err) {
        summary.errors.push(`attachment: ${String(err.message || err)}`)
      }

      const { classification: result, usage } = await classifyEmail(email, context, documents)
      // Claude呼び出し1回＋この後のDB書き込み（利用量の加算・タスク登録 or 判定済み記録）ぶん
      budget.use(3)
      usageInput += usage.input_tokens
      usageOutput += usage.output_tokens
      classifyCalls += 1

      // 1件ごとに日次利用量へ加算し、加算後の合計で上限を判定する（2026-09-04）。
      // 実行の最後にまとめて記録する方式だと、1回の実行の中で暴走したときに歯止めが
      // 効かないため、ここで都度チェックして超えた時点で以降の分類を止める。
      const dailyTotal = await addTodayUsage(supabase, {
        input: usage.input_tokens,
        output: usage.output_tokens,
        calls: 1,
      })
      if (dailyTotal && dailyTotal.costUSD >= limitState.limitUSD) {
        limitState = { ...limitState, exceeded: true, usage: dailyTotal }
        const message =
          `本日のAI利用が上限（$${limitState.limitUSD.toFixed(2)}）に達したため、以降のAI処理を停止しました` +
          `（本日の推定利用額 $${dailyTotal.costUSD.toFixed(2)}）。設定画面の「AI利用の1日あたり上限」で変更できます。`
        summary.errors.push(message)
        await setLimitAlert(supabase, message)
      }
      if (result.channel === 'fax') {
        faxUsageInput += usage.input_tokens
        faxUsageOutput += usage.output_tokens
        classifyFaxCalls += 1
      }

      // カード・詳細画面のアイコン表示用（メール/フォーム/FAX の区別）。
      // 分類できない・想定外の値は既定の "email" にする。
      // フォームの自動送信メール・FAXゲートウェイ受信メールは本文から確実に判定できるため、
      // Claude の判定結果より優先する（分類漏れで "email" になるのを防ぐ）。特にFAXは、
      // channel が 'fax' でないと下流の「業務外でも必ずタスク化」の保護（isFaxNonBusinessOverride）が
      // 効かず、広告的なFAXが業務外として静かに捨てられてしまうため、ここで決定的に固定するのが重要。
      const channel = isFormSubmission(email)
        ? 'form'
        : isFaxGatewayEmail(email)
          ? 'fax'
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
        // タスクを作らないため、ここで判定済みとして記録しないと次の巡回でまた
        // Claude に送られてしまう（2026-09-04のAPIクレジット浪費の原因）。
        judgedMessages.add(email.id)
        const { error: judgedErr } = await supabase
          .from('processed_messages')
          .upsert(
            { gmail_message_id: email.id, reason: 'non_business', subject: email.subject || null },
            { onConflict: 'gmail_message_id' }
          )
        // 記録に失敗すると再分類による課金が続くため、ログに出して気づけるようにする
        if (judgedErr) summary.errors.push(`processed_messages: ${judgedErr.message}`)
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

      // contact（先方＝顧客の宛名）を会社名・氏名に構造化して分けたもの（連絡帳の自動作成用。
      // 2026-09-01追加）。sender_display は「送信元」＝自社発信のメールでは自社側の氏名になって
      // しまうため使わない。contact は往信・返信どちらでも常に「先方（顧客）」を指すため、
      // これを分割する方が連絡帳の会社名・担当者名として正しい
      const contactCompany =
        !isFaxReadFailure && typeof result.contact_company === 'string' && result.contact_company.trim()
          ? result.contact_company.trim().slice(0, 120)
          : null
      const contactPerson =
        !isFaxReadFailure && typeof result.contact_person === 'string' && result.contact_person.trim()
          ? result.contact_person.trim().slice(0, 120)
          : null

      // 返信先アドレス: Claude の抽出（フォーム経由は本文のアドレス）を優先し、
      // 無ければ Reply-To → From の順にフォールバック
      const senderEmail = isFaxReadFailure
        ? extractEmail(email.replyTo) || extractEmail(email.from)
        : extractEmail(result.sender_email) || extractEmail(email.replyTo) || extractEmail(email.from)

      // 受信メールのCcに入っていた先方アドレス（連絡帳の自動作成用。自社アドレスは除く）
      const senderCc = extractEmails(email.cc || '').filter((a) => !isCompanyAddress(a)).join(', ') || null

      // docSummary は title の直前で計算済み（FAX 転送メールは本文がほぼ無いため、
      // この要約を本文としても表示する。通常メールで本文もある場合は本文の後ろに
      // 添付内容を追記する。FAX読み取り失敗時は要約自体が信頼できないため使わず、
      // 失敗理由を代わりに表示する）。
      const emailBody = compactBody(email.body)
      // FAXゲートウェイの本文は FROM=/TO=/DATE=/TIME=/TIMEZONE=/FCODE=/RJOBNUM= という
      // 受信情報のみで業務内容を含まない。このうち RJOBNUM（受信ジョブ番号。複合機側で
      // 受信書類を特定する際に使う）だけは残す価値があるため、FAXの場合はこの部分だけを
      // 抽出して使う。本文が1行に潰れている場合（HTML由来・snippetフォールバック）でも
      // 拾えるよう、行頭限定ではなく「RJOBNUM=<値>」のトークンを本文中から抽出する。
      const faxJobNumberLine = isFax ? (email.body || '').match(/RJOBNUM=\S+/i)?.[0]?.trim() || null : null
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
        contact_company: contactCompany,
        contact_person: contactPerson,
        sender_email: senderEmail,
        sender_cc: senderCc,
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
        'id, task_no, status, gmail_thread_id, gmail_message_id, title, subject, sender, sender_email, body_preview, classification_note, last_reply_message_id'
      )
      .in('status', ['未処理', '返信済み'])
      .eq('source', 'email')
    budget.use(1)

    // 1巡回あたりの対象を REPLY_CHECK_MAX_TASKS 件に絞る（2026-09-04）。全件を毎回見ると
    // タスク数に比例してサブリクエストを消費し、上限超過で後続の処理（利用量の記録・
    // 操作ログ）まで巻き添えになるため（9/3は進行中30件＝スレッド読み取り30回で
    // 上限50をほぼ使い切っていた）。
    //
    // 優先順位を付ける:
    //   - 「未処理」… 初回の返信検知。対応漏れに直結し件数も少ないので**毎回全件**見る
    //   - 「返信済み」… さらなる返信の取り込み。件数が多く緊急度も低いので、
    //     余った枠を前回の続きから順に割り当てる（settings.reply_check_cursor に進捗を
    //     残し、一周したら先頭へ戻る）。全件を回るのに数巡かかるぶん検知は遅れるが、
    //     取りこぼしはしない。
    const sortedTasks = (openTasks || []).slice().sort((a, b) => Number(a.task_no) - Number(b.task_no))
    const pendingTasks = sortedTasks.filter((t) => t.status === '未処理')
    const repliedTasks = sortedTasks.filter((t) => t.status !== '未処理')
    const targets = pendingTasks.slice(0, REPLY_CHECK_MAX_TASKS)

    const cursor = Number(settings.reply_check_cursor) || 0
    const slots = Math.max(REPLY_CHECK_MAX_TASKS - targets.length, 0)
    const rotated = []
    if (repliedTasks.length > 0 && slots > 0) {
      let startIndex = repliedTasks.findIndex((t) => Number(t.task_no) > cursor)
      if (startIndex < 0) startIndex = 0
      for (let k = 0; k < repliedTasks.length && rotated.length < slots; k += 1) {
        rotated.push(repliedTasks[(startIndex + k) % repliedTasks.length])
      }
      targets.push(...rotated)
    }
    // 一周し切ったか（＝返信済みを全件見たか）で次回の開始位置を決める
    const repliedRemaining = Math.max(repliedTasks.length - rotated.length, 0)
    deferred.replyCheck =
      Math.max(pendingTasks.length - Math.min(pendingTasks.length, REPLY_CHECK_MAX_TASKS), 0) + repliedRemaining
    let lastCheckedNo = cursor

    for (const task of targets) {
      // 予算切れなら残りは次の巡回へ。cursor を進めていないので取りこぼしにはならない
      if (!budget.has(4)) {
        deferred.replyCheck += 1
        continue
      }
      try {
        const messages = await getThreadMessages(accessToken, task.gmail_thread_id)
        budget.use(1)
        // 巡回位置は「返信済み」タスクにだけ意味がある（未処理は毎回全件見るため）
        if (task.status !== '未処理') lastCheckedNo = Number(task.task_no) || lastCheckedNo
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
        // スレッド内の「タスク登録の元メール以外で最も新しい関連メッセージ」を探す。
        // 自社発なら従来通りの返信検知（未処理→返信済み）、顧客発なら顧客返信として扱い
        // ステータスを未処理へ戻す（2026-07-29。従来は自社発のみを対象にしていたため、
        // 自社発信で登録されたタスクに顧客が返答しても一切反映されず見落としになっていた）。
        // 返信は定義上、タスク登録の元メールより「後」に来たもの。getThreadMessages は
        // 古い順に返すため、元メールの位置より後ろのメッセージだけを候補にする。
        // このガードが無いと、元メールより古いメッセージを返信と誤認する。実際、元メールと
        // 返信が逆転して取り込まれたタスクで、過去の顧客メールを「顧客からの返信」と誤認して
        // ステータスを未処理に戻す事象が起きた（2026-08-03。T-88の事例）。
        // 元メールがスレッド内に見つからない場合（-1）は従来通り全件を候補にする。
        const originIndex = messages.findIndex((m) => m.id === task.gmail_message_id)
        let reply = null
        let replyIsFromCustomer = false
        for (let i = messages.length - 1; i > originIndex; i--) {
          const m = messages[i]
          if (m.id === task.gmail_message_id) continue
          const from = (extractEmail(m.from) || '').toLowerCase()
          const recipients = `${m.to || ''} ${m.cc || ''}`.toLowerCase()
          if (isCompanyAddress(from)) {
            // 自社発の返信: 宛先に顧客を含むこと（同一件名で複数顧客がスレッドに
            // まとまる場合の混線防止。正当な返信は必ず顧客宛て）
            if (!recipients.includes(counterpart)) continue
            reply = m
            replyIsFromCustomer = false
            break
          }
          // 顧客発の返信: 差出人がこのタスクの顧客(counterpart)本人であることを要件にする
          // （別顧客のメッセージが同一スレッドに混在した場合の誤反映を防ぐ）
          if (from !== counterpart) continue
          reply = m
          replyIsFromCustomer = true
          break
        }
        if (!reply) continue
        // 既に取り込んだ返信と同じなら、本文の再取得もせずスキップする
        // （返信済みタスクを毎サイクル走査するため、同じ返信の再適用・コスト増を防ぐ）。
        if (reply.id === task.last_reply_message_id) continue
        // 返信の本文でタスク詳細を更新するため、対象メッセージ全体を取得する
        const replyEmail = await getMessage(accessToken, reply.id)
        budget.use(2)
        if (replyIsFromCustomer) {
          await incorporateCustomerReply(task, 'スレッドで顧客からの返信を検知', replyEmail)
        } else {
          await incorporateReply(task, 'スレッドで返信を検知', replyEmail)
        }
      } catch (err) {
        summary.errors.push(`reply-check: ${String(err.message || err)}`)
      }
    }

    // 次回の開始位置（返信済みタスクの巡回位置）を記録する。
    // 一周し切った＝残りが無いときは先頭へ戻す。値が変わらないなら書き込まない。
    if (rotated.length > 0) {
      const nextCursor = repliedRemaining > 0 ? lastCheckedNo : 0
      if (nextCursor !== cursor) {
        await supabase
          .from('settings')
          .upsert({ key: 'reply_check_cursor', value: String(nextCursor) }, { onConflict: 'key' })
        budget.use(1)
      }
    }
  }

  // 3.5) Google カレンダー「栄和共通」の当日イベントをタスク化（未処理に登録）
  summary.calendarCreated = 0
  const calendarName = (settings.calendar_name || '栄和共通').trim()
  // 予算が残っていないときは今回は見送る（次の巡回で拾う。当日のイベントを
  // 対象にしているので、5〜30分後の巡回で取り込めれば実用上は問題ない）
  if (calendarName && !budget.has(6)) {
    deferred.calendar = true
  } else if (calendarName) {
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
        budget.use(2)
        for (const ev of events) {
          const key = `cal:${ev.id}`
          // カレンダーイベントの重複判定はタスクの状態を問わない（メッセージ単位のexistingMessagesを
          // 使う。2026-08-17: existingThreads は「進行中の会話があるスレッドか」用に意味を変えたため、
          // ここでの流用をやめた。完了済みのカレンダータスクでも同じイベントを再登録しないようにする）
          if (existingMessages.has(ev.id)) continue
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
            existingMessages.add(ev.id)
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

  // 4-2) 上限アラートの解除（2026-09-04）。日付が変わって上限内に戻れば自動で消す
  if (!limitState.exceeded) await clearLimitAlert(supabase)

  // 5) クレジット不足アラートの設定／解除
  if (billingError) {
    summary.creditAlert = billingError
    await supabase.from('settings').upsert(
      { key: 'api_credit_alert', value: JSON.stringify({ message: billingError, at: new Date().toISOString() }) },
      { onConflict: 'key' }
    )
    // 端末へ通知する（2026-09-04。依頼）。**アラートが立っていなかった時だけ**送る
    // ＝残高が尽きた最初の1回のみ。巡回のたびに鳴り続けるのを防ぐため、
    // 実行開始時に読み込んだ settings の値（＝今回の書き込み前の状態）で判定する。
    if (!settings.api_credit_alert) {
      await notifyApiAlert({
        title: 'APIクレジットが不足しています',
        body: 'メールの自動分類が停止しています。チャージ後、ハンバーガーメニューの「今すぐ取得」で再開できます。',
        url: '/usage',
      })
    }
  } else if (classifyCalls > 0) {
    // 正常に分類できたのでアラートを解除
    await supabase.from('settings').upsert(
      { key: 'api_credit_alert', value: '' },
      { onConflict: 'key' }
    )
  }

  // 積み残し・サブリクエストの使用状況を残す（処理ログの詳細から追えるようにする）
  if (mailTruncated) {
    // 取りこぼし防止のため、この回は last_fetch_at を進めない（手順7参照）。
    // 「取得はしたが処理していないメールがある」ことを画面に赤字で出したいので errors に積む。
    summary.errors.push(
      `メールを ${deferred.mail} 件、次回の巡回に繰り越しました（Workerの外部リクエスト上限の保護）。` +
        '取得位置は処理済みの位置までしか進めていないため、取りこぼしにはなりません。'
    )
  }
  summary.deferred = deferred
  summary.subrequests = budget.snapshot()

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
  // エラーが1件でもあれば 'error' 種別（画面では赤いバッジ）にする。2026-09-04:
  // クレジット不足などの失敗が「メール取得」という平常時と同じ見た目で流れてしまい、
  // 一覧を眺めても異常だと気づけなかったため（依頼）。
  // サブリクエスト上限に当たったエラーは原因が分かりにくいので、平易な説明を添える
  // （2026-09-04。9/3の事故ではこの英語のメッセージだけがCloudflareのログに出ていて、
  // 画面側には何も残っていなかった）。
  if (summary.errors.some((e) => /Too many subrequests/i.test(String(e)))) {
    summary.errors.unshift(
      'Cloudflare Workers の1回あたりの外部リクエスト上限に達しました' +
        `（上限 ${budget.limit} 回 / 概算 ${budget.used} 回使用）。` +
        '返信検知・カレンダー登録・利用量の記録などが一部実行できていません。'
    )
  }
  const hasErrors = summary.errors.length > 0
  // 予算切れで次回に回した処理（エラーではないが、気づけるようにログ本文に出す）
  const deferredParts = []
  if (deferred.mail > 0) deferredParts.push(`メール ${deferred.mail} 件`)
  if (deferred.replyCheck > 0) deferredParts.push(`返信検知 ${deferred.replyCheck} 件`)
  if (deferred.calendar) deferredParts.push('カレンダー')
  const fetchMessage =
    `${hasErrors ? 'メール取得エラー' : 'メール取得'}: 取得 ${summary.fetched} 件 / 新規タスク ${summary.created} 件 / ` +
    `返信検知 ${summary.replied} 件 / 返信更新 ${summary.updated} 件 / 業務外 ${summary.nonBusiness} 件 / ` +
    `カレンダー登録 ${summary.calendarCreated} 件 / アーカイブ ${summary.archived} 件` +
    (deferredParts.length ? ` / 次回へ繰り越し（${deferredParts.join('・')}）` : '') +
    (hasErrors ? ` / エラー ${summary.errors.length} 件（${summary.errors[0]}）` : '')
  logRows.unshift({ log_type: hasErrors ? 'error' : 'fetch', actor, message: fetchMessage, detail: summary })
  const { error: logError } = await supabase.from('activity_logs').insert(logRows)
  if (logError) console.error('操作ログの書き込みに失敗:', logError.message)
  await supabase
    .from('activity_logs')
    .delete()
    .lt('created_at', new Date(Date.now() - LOG_RETENTION_DAYS * 86400000).toISOString())

  // 業務外判定の記録も同じ保持期間で掃除する。取得クエリは last_fetch_at 以降しか
  // 見ないため、古い記録を残し続ける必要はない（残すと照合対象が無限に増える）。
  await supabase
    .from('processed_messages')
    .delete()
    .lt('judged_at', new Date(Date.now() - LOG_RETENTION_DAYS * 86400000).toISOString())

  // 7) last_fetch_at を更新
  // **予算切れでメールを積み残した回は前進させない**（2026-09-04）。取得窓を進めると、
  // まだ本文も見ていないメールが次回の対象から外れて永久に取りこぼされるため。
  // 積み残しがある間は同じ窓を再取得することになるが、処理済み・業務外判定済みの
  // メッセージは本文取得より前にスキップするので、Claude課金もGmailの通信も増えない。
  if (mailTruncated) {
    // 予算切れで積み残した回は「現在時刻」まで進めてはいけない（まだ本文も見ていない
    // メールが次回の対象から外れ、永久に取りこぼす）。処理を終えた最後のメールの
    // 受信時刻まで進め、残りは次の巡回で続きから拾う。同じ秒に届いた別のメールを
    // 落とさないよう1秒戻す（重複は既存の重複判定で弾かれるだけなので害はない）。
    // 受信時刻が1件も取れていない（＝1通も処理できなかった）ときは進めない。
    const base = lastProcessedReceivedAt ? new Date(lastProcessedReceivedAt).getTime() : NaN
    if (Number.isFinite(base)) {
      await supabase
        .from('settings')
        .update({ value: new Date(base - 1000).toISOString() })
        .eq('key', 'last_fetch_at')
    }
  } else {
    await supabase
      .from('settings')
      .update({ value: new Date().toISOString() })
      .eq('key', 'last_fetch_at')
  }

  return summary
}
