import { useEffect, useState } from 'react'
import { IconMail } from './Icons'
import { createMeterDraft, fetchMeterMailSettings, saveMeterMailSettings } from '../lib/meter'
import { meterFileMonth } from '../lib/meterXlsx'

// 件名・本文の %YYYYMM% を置き換えた見本（サーバーの fillMonth と同じ）
function fillMonth(text, month) {
  return String(text || '').replaceAll('%YYYYMM%', meterFileMonth(month))
}

/**
 * 検針のメール下書きのカード（宛先・件名・本文の確認と編集、Gmail〔共有アドレス〕への下書き作成）。
 * 検針データの提出メール（kind='report'。Phase 3）とガス検針票の送付メール（kind='gas'。Phase 4。2026-11-10〜）で共通。
 * 送信はしない。Gmail で中身を確かめてから人が送る（Q7・D2）
 * @param {{ kind: 'report'|'gas', month: string, title: string, note: React.ReactNode, attachmentNames: string[],
 *   makeFiles: () => Promise<{ blob: Blob, name: string }[]>, disabledReason?: string, children?: React.ReactNode }} props
 *   children は添付を選ぶ欄など（宛先の表示の上に出す）
 */
export default function MeterMailCard({ kind, month, title, note, attachmentNames, makeFiles, disabledReason = '', children }) {
  const [mail, setMail] = useState(null)
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState(null)

  useEffect(() => {
    let alive = true
    fetchMeterMailSettings(kind)
      .then((s) => alive && setMail(s))
      .catch((err) => alive && setError(err.message))
    return () => {
      alive = false
    }
  }, [kind])

  useEffect(() => setDraft(null), [month])

  async function run(label, fn) {
    setBusy(label)
    setError('')
    setNotice('')
    try {
      await fn()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const makeDraft = () =>
    run('draft', async () => {
      setDraft(null)
      setDraft(await createMeterDraft(kind, month, await makeFiles()))
    })

  const saveMail = () =>
    run('mail', async () => {
      setMail(await saveMeterMailSettings(editing, kind))
      setEditing(null)
      setNotice('メールの設定を保存しました')
    })

  return (
    <section className="ui-card meter-report-card">
      <h3 className="ui-card-title">{title}</h3>
      <p className="ui-note">{note}</p>
      {error && (
        <p className="meter-check-ng" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="meter-check-ok">{notice}</p>}
      {!mail ? (
        !error && <p className="dashboard-loading">読み込み中…</p>
      ) : editing ? (
        <div className="meter-mail-form">
          <label className="ui-field">
            <span>宛先（TO）</span>
            <textarea
              className="ui-textarea"
              value={editing.to}
              onChange={(e) => setEditing({ ...editing, to: e.target.value })}
              placeholder="名前 <name@example.co.jp>; 名前 <name2@example.co.jp>"
            />
          </label>
          <label className="ui-field">
            <span>CC</span>
            <textarea className="ui-textarea" value={editing.cc} onChange={(e) => setEditing({ ...editing, cc: e.target.value })} />
          </label>
          <p className="ui-note">
            複数は「;」「,」か改行で区切ります。「名前 &lt;アドレス&gt;」の形でも、アドレスだけでもかまいません（FileMaker のコンスタントマスタの値をそのまま貼れます）。
          </p>
          <label className="ui-field">
            <span>件名（%YYYYMM% は「{meterFileMonth(month)}」のように置き換わります）</span>
            <input className="ui-input" value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} />
          </label>
          <label className="ui-field">
            <span>本文</span>
            <textarea className="ui-textarea is-body" value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
          </label>
          <label className="ui-field">
            <span>返信先（任意。本文の最後に「ご返信は〜までお願いいたします。」と書き添えます）</span>
            <input
              className="ui-input"
              inputMode="email"
              value={editing.reply_to}
              onChange={(e) => setEditing({ ...editing, reply_to: e.target.value })}
            />
          </label>
          <div className="meter-report-actions">
            <button type="button" className="btn-primary" onClick={saveMail} disabled={!!busy}>
              {busy === 'mail' ? '保存中…' : '保存する'}
            </button>
            <button type="button" className="btn-plain" onClick={() => setEditing(null)} disabled={!!busy}>
              やめる
            </button>
          </div>
        </div>
      ) : (
        <>
          {children}
          <dl className="meter-facts meter-mail-preview">
            <div>
              <dt>宛先（TO）</dt>
              <dd>{mail.to || '（未登録）'}</dd>
            </div>
            <div>
              <dt>CC</dt>
              <dd>{mail.cc || '（なし）'}</dd>
            </div>
            <div>
              <dt>件名</dt>
              <dd>{fillMonth(mail.subject, month)}</dd>
            </div>
            <div>
              <dt>添付</dt>
              <dd>{attachmentNames.length ? attachmentNames.join('\n') : '（まだありません）'}</dd>
            </div>
          </dl>
          <details className="meter-mail-preview">
            <summary>本文を見る</summary>
            <p className="meter-mail-body">
              {fillMonth(mail.body, month)}
              {mail.reply_to ? `\n\nご返信は ${mail.reply_to} までお願いいたします。` : ''}
            </p>
          </details>
          <div className="meter-report-actions">
            <button type="button" className="btn-primary" onClick={makeDraft} disabled={!!busy || !mail.to || !!disabledReason}>
              <IconMail size={18} />
              {busy === 'draft' ? '下書きを作成中…' : 'Gmail に下書きを作る'}
            </button>
            <button type="button" className="btn-plain" onClick={() => setEditing({ ...mail })} disabled={!!busy}>
              宛先・件名・本文を変える
            </button>
          </div>
          {!mail.to ? (
            <p className="ui-note">先に「宛先・件名・本文を変える」で宛先を登録してください。</p>
          ) : (
            disabledReason && <p className="ui-note">{disabledReason}</p>
          )}
          {draft && (
            <div className="meter-check-result">
              <p className="meter-check-ok">
                下書きを作りました（宛先 {draft.to_count}件・CC {draft.cc_count}件・添付{draft.attachment_count ?? attachmentNames.length}つ）。Gmail
                で確かめてから送信してください。
              </p>
              <div className="meter-report-actions">
                <a className="btn-primary" href={draft.draft_url} target="_blank" rel="noreferrer">
                  Gmail で下書きを開く
                </a>
                <a className="btn-plain" href={draft.drafts_url} target="_blank" rel="noreferrer">
                  下書きフォルダを開く
                </a>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
