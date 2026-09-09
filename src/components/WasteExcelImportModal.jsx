import { useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { IconChevronLeft, IconChevronRight } from './Icons'
import PdfBusyOverlay from './PdfBusyOverlay'
import { parseWasteExcelFile } from '../lib/wasteExcelImport'
import { importWasteRecords } from '../lib/waste'
import { shiftMonth } from '../lib/reports'

// Excel取込（docs/waste-plan.md 5-2改訂。2026-09-09〜）。手書きシートの写真スキャン
// （Claude Vision）が実際の筆跡で読み取り失敗続きだったため、依頼元がAIチャット等で
// Excel化した実測値をそのまま取り込む方式に変更した。ファイルはブラウザ内で直接読み取り
// （src/lib/wasteExcelImport.js）、サーバーへは日×階の値だけを送る（画像のような
// アップロード・保存は不要）。読み取り結果は is_confirmed=false の下書きとして保存され、
// 閉じた後の一覧（月別表示）で人が確認・訂正する（この画面自体には結果のプレビューは出さない。
// 従来のスキャン取込モーダルと同じ考え方）。
export default function WasteExcelImportModal({ defaultMonth, onClose, onDone }) {
  useBodyScrollLock()

  const [month, setMonth] = useState(defaultMonth)
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [busyLabel, setBusyLabel] = useState('')
  const [error, setError] = useState('')

  function handlePick(fileList) {
    const picked = fileList?.[0]
    if (!picked) return
    setError('')
    setFile(picked)
  }

  async function handleSubmit() {
    if (!file) {
      setError('Excelファイルを選んでください')
      return
    }
    setBusy(true)
    setError('')
    try {
      setBusyLabel('Excelを読み取り中…')
      const { rows } = await parseWasteExcelFile(file, month)
      if (rows.length === 0) {
        setError('読み取れる実測値がありませんでした。ファイルの形式をご確認ください。')
        setBusy(false)
        setBusyLabel('')
        return
      }
      setBusyLabel('保存中…')
      const { imported } = await importWasteRecords(rows)
      onDone(month, imported)
    } catch (err) {
      setError(err.message)
      setBusy(false)
      setBusyLabel('')
    }
  }

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={busy ? undefined : onClose}>
      <div className="ui-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h2>Excelアップロード</h2>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる" disabled={busy}>
            ×
          </button>
        </div>
        <div className="ui-modal-body is-stacked">
          <div className="ui-field">
            <label>対象月</label>
            <div className="inspection-month">
              <button
                type="button"
                className="icon-btn-nav"
                onClick={() => setMonth((m) => shiftMonth(m, -1))}
                aria-label="前月"
                title="前月"
                disabled={busy}
              >
                <IconChevronLeft size={24} />
              </button>
              <span className="inspection-month-label">{month.replace('-', '年')}月</span>
              <button
                type="button"
                className="icon-btn-nav"
                onClick={() => setMonth((m) => shiftMonth(m, 1))}
                aria-label="翌月"
                title="翌月"
                disabled={busy}
              >
                <IconChevronRight size={24} />
              </button>
            </div>
          </div>

          <label className="ui-field">
            <span>廃棄物実測集計表（.xlsx）</span>
            <input
              type="file"
              accept=".xlsx"
              className="ui-input"
              disabled={busy}
              onChange={(e) => handlePick(e.target.files)}
            />
          </label>
          <p className="ui-note">
            「日・曜日・1〜7階・合計」の列を持つ、添付の記入用シートと同じ形式のExcelファイルを選んでください。
          </p>

          {error && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start" />
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose} disabled={busy}>
              キャンセル
            </button>
            <button type="button" className="btn-primary" onClick={handleSubmit} disabled={busy || !file}>
              {busy ? busyLabel || '処理中…' : '取り込む'}
            </button>
          </div>
        </div>
      </div>
      <PdfBusyOverlay show={busy} label={busyLabel || '処理しています…'} />
    </div>
  )
}
