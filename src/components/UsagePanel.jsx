import { useEffect, useMemo, useState } from 'react'
import { fetchUsageMonths, fetchSettings } from '../lib/tasks'
import { saveSettings } from '../lib/api'
import { fetchStorageUsage } from '../lib/reports'
import { estimateCostUSD, formatUSD, formatJPY, BILLING_URL } from '../lib/pricing'
import { formatBytes } from '../lib/imageResize'

// AI利用の1日あたり上限（USD）の既定値。worker/lib/usageLimit.js と同じ値を保つこと
const DEFAULT_DAILY_LIMIT_USD = 0.5

// この金額を下回る上限は「平常運転でも到達してしまう」危険水域として警告する。
// 平常時の実績は0.06〜0.08ドル/日（docs/ai-cost-and-alternatives.md 1章）。
// 2026-09-04、本番の設定値が 0.05 になっているのを発見したため追加した（既定 0.50 の
// 打ち間違いと思われる）。0.05 では平常の利用でほぼ毎日サーキットブレーカーが作動し、
// メールの自動分類が静かに止まり続ける状態だった。入力欄の下限・刻みが 0.05 のため、
// 矢印キーの操作だけでも到達してしまう。
const LOW_LIMIT_WARN_USD = 0.1

// 1日あたり上限の設定（2026-09-04。当初はタスク設定に置いたが、金額の設定は課金実績と
// 同じ画面で見られる方が分かりやすいため、依頼によりこの画面へ移設した）
function DailyLimitSection() {
  const [limit, setLimit] = useState(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchSettings()
      .then((s) => {
        const n = Number(s.daily_api_cost_limit_usd)
        setLimit(Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT_USD)
      })
      .catch((err) => setError(err.message))
  }, [])

  async function handleSave() {
    setSaving(true)
    setStatus('')
    setError('')
    try {
      const n = Number(limit)
      const safe = Number.isFinite(n) && n > 0 ? Math.min(50, Math.max(0.05, n)) : DEFAULT_DAILY_LIMIT_USD
      setLimit(safe)
      await saveSettings({ daily_api_cost_limit_usd: String(safe) })
      setStatus('保存しました')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (limit === null && !error) return null

  const limitNum = Number(limit)
  const tooLow = Number.isFinite(limitNum) && limitNum > 0 && limitNum < LOW_LIMIT_WARN_USD

  return (
    <section className="usage-panel">
      <div className="usage-panel-title">
        <h2>AI利用の1日あたり上限</h2>
      </div>
      {error && (
        <p className="dashboard-error dashboard-banner" role="alert">
          {error}
        </p>
      )}
      <div className="usage-limit-row">
        <label className="usage-limit-label">
          上限（ドル／日）
          <input
            className="ui-input usage-limit-input"
            type="number"
            inputMode="decimal"
            min={0.05}
            max={50}
            step={0.05}
            value={limit ?? ''}
            onChange={(e) => setLimit(e.target.value)}
          />
        </label>
        <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
        {status && <span className="usage-limit-status">{status}</span>}
      </div>
      {tooLow && (
        <p className="usage-limit-warning" role="alert">
          この上限は通常の利用実績（1日あたり0.06〜0.08ドル）を下回っています。このままでは
          ほぼ毎日上限に達して、メールの自動分類が止まったままになります。
          特に理由がなければ {DEFAULT_DAILY_LIMIT_USD.toFixed(2)} ドルに戻してください。
        </p>
      )}
      <p className="settings-hint usage-note">
        メールの自動分類・FAX や写真の読み取りに使うAI（Claude）の利用額が、1日でこの金額に達すると
        <strong>その日のAI処理を自動的に停止します</strong>
        （不具合などで想定外に使い続けてしまった場合の歯止めです）。
        日付が変われば自動的に再開します。停止中も、タスク管理・日報などAI以外の機能は通常どおり使えます。
        通常の利用実績は1日あたり0.06〜0.08ドル程度のため、初期値の0.50ドルなら通常の運用で止まることはありません。
      </p>
    </section>
  )
}

// 運用上の留意事項・設定要領（2026-09-05。依頼）。
// 2026-09-03の課金事故（HANDOFF 219〜226番・docs/ai-cost-and-alternatives.md 9章）で
// 得た知見のうち、**運用する人が知っておく必要があること**だけを画面に出す。
// 設計の詳細・経緯はドキュメント側に置き、ここは「平常値」「止まったときの見分け方」
// 「触ってよい設定と、その目安」に絞る。
function OperationGuide() {
  return (
    <section className="usage-panel">
      <div className="usage-panel-title">
        <h2>運用上の留意事項・設定要領</h2>
      </div>

      <h3 className="usage-guide-head">1. 平常時の目安</h3>
      <ul className="usage-guide-list">
        <li>
          AIの利用額は<strong>1日あたり0.06〜0.08ドル（月2〜3ドル程度）</strong>が平常値です。
          上の表の月次コストがこの範囲なら正常です。
        </li>
        <li>
          <strong>1日0.2ドルを超える日が続いたら異常</strong>を疑ってください。
          同じメールを繰り返しAIに送ってしまう不具合が実際に起きたことがあります（2026-09-03）。
        </li>
        <li>
          この画面の金額は当システムが数えたトークンからの試算です。
          <strong>確定額はAnthropicの請求が正</strong>なので、大きく食い違うときはコンソール側を確認してください。
        </li>
      </ul>

      <h3 className="usage-guide-head">2. AIが止まったときの見分け方</h3>
      <p className="usage-guide-lead">
        AIが止まっても、タスク管理・日報・備品などAI以外の機能は通常どおり使えます。
        止まる理由は3つで、画面の出方で区別できます。
      </p>
      <div className="usage-guide-table-wrap">
        <table className="usage-guide-table">
          <thead>
            <tr>
              <th>画面に出るもの</th>
              <th>意味</th>
              <th>対処</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">ダッシュボードの赤いバナー「APIクレジットが不足しています」＋端末への通知</th>
              <td>Anthropicの残高切れ。新しいメールの自動分類が止まっています</td>
              <td>
                上の「Anthropic API 支払設定」からチャージし、
                ハンバーガーメニューの<strong>「今すぐ取得」</strong>で再開
              </td>
            </tr>
            <tr>
              <th scope="row">「AI利用が1日の上限に達しました」のバナー＋通知</th>
              <td>上の「AI利用の1日あたり上限」に達して自動停止した状態</td>
              <td>
                日付が変われば自動的に再開します。すぐ再開したいときは上限を上げる
              </td>
            </tr>
            <tr>
              <th scope="row">処理ログの赤い「メール取得エラー」</th>
              <td>取得・分類のどこかで失敗しています</td>
              <td>
                ログ本文の末尾にエラー内容が出ます。意味が分からない場合はそのまま開発側へ連絡
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 className="usage-guide-head">3. 設定の要領</h3>
      <ul className="usage-guide-list">
        <li>
          <strong>1日あたり上限（この画面）</strong>: 初期値0.50ドル。平常値の6倍以上あるので、
          通常の運用で止まることはありません。
          <strong>0.10ドルを下回る値にしないでください</strong>（平常の利用でほぼ毎日止まります。
          入力すると赤い警告が出ます）。
          動作を試したいときだけ一時的に0.05ドルにし、<strong>確認後は必ず0.50に戻してください</strong>。
        </li>
        <li>
          <strong>Anthropic側（コンソール）</strong>: 自動リチャージは<strong>オフ</strong>にし、
          コンソール側の上限も設定しておくと、アプリ側の上限と合わせて二重の歯止めになります。
        </li>
        <li>
          <strong>「今すぐ取得」の連打は避けてください</strong>。1回押すごとに新着メールをAIに
          読ませるため、その分だけ費用がかかります（通常は30分ごとに自動で取得しています）。
        </li>
      </ul>

      <h3 className="usage-guide-head">4. 処理ログに出る「繰り越し」について</h3>
      <ul className="usage-guide-list">
        <li>
          <strong>「次回へ繰り越し（…）」</strong>: 1回の処理で扱える通信量の上限に近づいたため、
          残りを次の巡回（30分後）に回した、という意味です。<strong>取りこぼしではありません</strong>。
          たまに出るぶんには対処不要です。
        </li>
        <li>
          <strong>赤い「外部リクエストが上限に近づいています」</strong>: 1日1回だけ出る事前警告です。
          出るようになったら、まず<strong>進行中（未処理・返信済み）のタスクを整理して「完了」に</strong>
          してください。これがいちばん効きます。それでも続く場合は開発側で設定を調整します。
        </li>
        <li>
          この警告を放置すると、返信検知・カレンダー登録・利用量の記録などが
          <strong>静かに失敗する</strong>状態になります（2026-09-03の事故の原因）。
          警告が出たら早めに手を打ってください。
        </li>
      </ul>
    </section>
  )
}

function currentMonthJST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }).slice(0, 7)
}

// 月別の行から表示用の集計値を作る。該当行が無い月は 0 件として扱う。
function summarize(rows) {
  const total = { calls: 0, faxCalls: 0, parkingCalls: 0, wasteCalls: 0, input: 0, output: 0 }
  for (const r of rows) {
    total.calls += r.calls || 0
    total.faxCalls += r.fax_calls || 0
    total.parkingCalls += r.parking_calls || 0
    total.wasteCalls += r.waste_calls || 0
    total.input += r.input_tokens || 0
    total.output += r.output_tokens || 0
  }
  return {
    ...total,
    // 「分類したメール」はFAX・車両画像・廃棄物スキャンを除いた件数（単価・読み取り対象が異なるため内訳を分ける）
    mailCalls: Math.max(total.calls - total.faxCalls - total.parkingCalls - total.wasteCalls, 0),
    costUSD: estimateCostUSD(total.input, total.output),
  }
}

// 従量課金事項: 月別の内訳表に全ての情報を出すので、以前あった「今月/先月/累計」の
// 期間切替・詳細表示は廃止した（2026-08-05）。一覧表だけで完結させる。
export default function UsagePanel() {
  const [months, setMonths] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  // 日報の写真によるストレージ使用量（2026-08-04）。無料枠1GBに対する余裕を常に見えるようにする
  const [storage, setStorage] = useState(null)
  const thisMonth = currentMonthJST()

  useEffect(() => {
    fetchUsageMonths()
      .then((rows) => setMonths(rows))
      .catch((err) => setError(err.message))
      .finally(() => setLoaded(true))
    // 取得に失敗しても API 利用状況の表示は妨げない
    fetchStorageUsage()
      .then(setStorage)
      .catch(() => setStorage(null))
  }, [])

  const rows = useMemo(() => months.map((r) => ({ month: r.month, ...summarize([r]) })), [months])
  const grand = useMemo(() => summarize(months), [months])

  return (
    <>
      <section className="usage-panel">
        <div className="usage-panel-title">
          <h2>Anthropic API 利用状況</h2>
          <a className="usage-billing-link" href={BILLING_URL} target="_blank" rel="noopener noreferrer">
            Anthropic API 支払設定
          </a>
        </div>
        {error ? (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        ) : !loaded ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : rows.length === 0 ? (
          <p className="settings-hint">利用実績がまだありません。</p>
        ) : (
          <div className="usage-table-wrap">
            <table className="usage-table">
              <thead>
                <tr>
                  <th>月</th>
                  <th className="num">メール</th>
                  <th className="num">FAX</th>
                  <th className="num">車両画像</th>
                  <th className="num">廃棄物</th>
                  <th className="num">入力トークン</th>
                  <th className="num">出力トークン</th>
                  <th className="num">推定コスト</th>
                  <th className="num">円換算（概算）</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.month} className={r.month === thisMonth ? 'is-current' : undefined}>
                    <th scope="row">
                      {r.month}
                      {r.month === thisMonth ? <span className="usage-badge">今月</span> : null}
                    </th>
                    <td className="num">{r.mailCalls.toLocaleString('ja-JP')}</td>
                    <td className="num">{r.faxCalls.toLocaleString('ja-JP')}</td>
                    <td className="num">{r.parkingCalls.toLocaleString('ja-JP')}</td>
                    <td className="num">{r.wasteCalls.toLocaleString('ja-JP')}</td>
                    <td className="num">{r.input.toLocaleString('ja-JP')}</td>
                    <td className="num">{r.output.toLocaleString('ja-JP')}</td>
                    <td className="num">{formatUSD(r.costUSD)}</td>
                    <td className="num">{formatJPY(r.costUSD)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">累計</th>
                  <td className="num">{grand.mailCalls.toLocaleString('ja-JP')}</td>
                  <td className="num">{grand.faxCalls.toLocaleString('ja-JP')}</td>
                  <td className="num">{grand.parkingCalls.toLocaleString('ja-JP')}</td>
                  <td className="num">{grand.wasteCalls.toLocaleString('ja-JP')}</td>
                  <td className="num">{grand.input.toLocaleString('ja-JP')}</td>
                  <td className="num">{grand.output.toLocaleString('ja-JP')}</td>
                  <td className="num">{formatUSD(grand.costUSD)}</td>
                  <td className="num">{formatJPY(grand.costUSD)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="settings-hint usage-note">
          当システムが計測したトークン数から Claude（claude-haiku-4-5）の料金で試算した目安です。
          実際の請求額は Anthropic の確定値が正となります。
        </p>
      </section>

      <DailyLimitSection />

      <OperationGuide />

      {storage && (
        <section className="usage-panel">
          <div className="usage-panel-title">
            <h2>日報の写真ストレージ</h2>
          </div>
          <dl className="usage-fields">
            <div className="usage-item">
              <dt>保存枚数</dt>
              <dd>{(storage.count || 0).toLocaleString('ja-JP')} 枚</dd>
            </div>
            <div className="usage-item">
              <dt>使用量</dt>
              <dd className="usage-cost">
                {formatBytes(storage.total_bytes || 0)}
                <span className="usage-jpy">
                  {' '}
                  / {formatBytes(storage.quota_bytes || 0)}（
                  {((storage.total_bytes / (storage.quota_bytes || 1)) * 100).toFixed(2)}%）
                </span>
              </dd>
            </div>
          </dl>
          <div className="storage-bar" aria-hidden="true">
            <div
              className="storage-bar-fill"
              style={{
                width: `${Math.min((storage.total_bytes / (storage.quota_bytes || 1)) * 100, 100)}%`,
              }}
            />
          </div>
          <p className="settings-hint">
            Supabase 無料プランの上限は 1GB です。写真は保存時に自動で縮小しており、
            現在のペースなら長期間この枠に収まります。
          </p>
        </section>
      )}
    </>
  )
}
