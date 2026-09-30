import { useEffect, useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { IconChevronLeft, IconChevronRight } from './Icons'
import PdfBusyOverlay from './PdfBusyOverlay'
import { parseWasteExcelBuffer, parseWasteExcelFile } from '../lib/wasteExcelImport'
import { fetchWasteDriveFileBuffer, fetchWasteDriveFiles, importWasteRecords } from '../lib/waste'
import { shiftMonth } from '../lib/reports'

// Excel取込（docs/waste-plan.md 5-2改訂。2026-09-09〜）。手書きシートの写真スキャン
// （Claude Vision）が実際の筆跡で読み取り失敗続きだったため、依頼元がAIチャット等で
// Excel化した実測値をそのまま取り込む方式に変更した。ファイルはブラウザ内で直接読み取り
// （src/lib/wasteExcelImport.js）、サーバーへは日×階の値だけを送る（画像のような
// アップロード・保存は不要）。読み取り結果は is_confirmed=false の下書きとして保存され、
// 閉じた後の一覧（月別表示）で人が確認・訂正する（この画面自体には結果のプレビューは出さない。
// 従来のスキャン取込モーダルと同じ考え方）。
//
// 2026-09-30〜: Googleドライブから直接選べるようにした（docs/waste-plan.md 10-7）。AIチャットで
// 手書き表を読み取らせるとGoogleドライブにスプレッドシートとして保存されるため、ダウンロード→
// アップロードの手間を省く。ドライブのファイルもサーバーが.xlsxで返すので、読み取りは
// ファイル選択と同じパーサー（parseWasteExcelBuffer）を通る。

// ファイル名の「2026年9月」から対象月 'YYYY-MM' を取り出す（無ければ null）
function monthFromName(name) {
  const m = /(\d{4})\s*年\s*(\d{1,2})\s*月/.exec((name || '').normalize('NFKC'))
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null
  return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`
}

function formatModified(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function WasteExcelImportModal({ defaultMonth, onClose, onDone }) {
  useBodyScrollLock()

  const [month, setMonth] = useState(defaultMonth)
  const [source, setSource] = useState('drive')
  const [file, setFile] = useState(null)
  const [driveFiles, setDriveFiles] = useState(null)
  const [driveLoading, setDriveLoading] = useState(false)
  const [driveError, setDriveError] = useState('')
  const [driveFileId, setDriveFileId] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyLabel, setBusyLabel] = useState('')
  const [error, setError] = useState('')

  // ドライブのファイル一覧は、ドライブ側を初めて開いたときに1回だけ取得する
  useEffect(() => {
    if (source !== 'drive' || driveFiles !== null || driveLoading) return
    setDriveLoading(true)
    setDriveError('')
    fetchWasteDriveFiles()
      .then((files) => {
        setDriveFiles(files)
        // 対象月の名前が付いたファイルがあればそれを、無ければ最新のファイルを選んでおく
        const preferred = files.find((f) => monthFromName(f.name) === month) || files[0]
        if (preferred) selectDriveFile(preferred.id, files)
      })
      .catch((err) => {
        setDriveFiles([])
        setDriveError(err.message)
      })
      .finally(() => setDriveLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  function selectDriveFile(id, files = driveFiles) {
    setError('')
    setDriveFileId(id)
    // ファイル名に年月があれば対象月をそれに合わせる（選び間違いによる月ずれを防ぐ）
    const picked = (files || []).find((f) => f.id === id)
    const nameMonth = monthFromName(picked?.name)
    if (nameMonth) setMonth(nameMonth)
  }

  function handlePick(fileList) {
    const picked = fileList?.[0]
    if (!picked) return
    setError('')
    setFile(picked)
  }

  const canSubmit = source === 'drive' ? Boolean(driveFileId) : Boolean(file)

  async function handleSubmit() {
    if (!canSubmit) {
      setError(source === 'drive' ? 'Googleドライブのファイルを選んでください' : 'Excelファイルを選んでください')
      return
    }
    setBusy(true)
    setError('')
    try {
      let rows
      if (source === 'drive') {
        setBusyLabel('Googleドライブから取得中…')
        const buffer = await fetchWasteDriveFileBuffer(driveFileId)
        setBusyLabel('読み取り中…')
        ;({ rows } = await parseWasteExcelBuffer(buffer, month))
      } else {
        setBusyLabel('Excelを読み取り中…')
        ;({ rows } = await parseWasteExcelFile(file, month))
      }
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

          <div className="ui-field">
            <label>取込元</label>
            {/* ui-field は子要素を横幅いっぱいに伸ばすため、切替ボタンはボタン幅に収まるよう div で包む */}
            <div>
              <div className="ui-segmented" role="group" aria-label="取込元">
                <button
                  type="button"
                  className={`ui-segmented-btn${source === 'drive' ? ' is-active' : ''}`}
                  aria-pressed={source === 'drive'}
                  onClick={() => setSource('drive')}
                  disabled={busy}
                >
                  Googleドライブから
                </button>
                <button
                  type="button"
                  className={`ui-segmented-btn${source === 'file' ? ' is-active' : ''}`}
                  aria-pressed={source === 'file'}
                  onClick={() => setSource('file')}
                  disabled={busy}
                >
                  ファイルを選ぶ
                </button>
              </div>
            </div>
          </div>

          {source === 'drive' ? (
            <label className="ui-field">
              <span>Googleドライブの廃棄物実測集計表</span>
              <select
                className="ui-select"
                value={driveFileId}
                disabled={busy || driveLoading || !driveFiles?.length}
                onChange={(e) => selectDriveFile(e.target.value)}
              >
                {driveLoading && <option value="">読み込み中…</option>}
                {!driveLoading && !driveFiles?.length && <option value="">（該当するファイルがありません）</option>}
                {driveFiles?.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}（{formatModified(f.modified_time)} 更新）
                  </option>
                ))}
              </select>
            </label>
          ) : (
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
          )}
          {source === 'drive' && driveError && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {driveError}（ダウンロード済みのファイルは「ファイルを選ぶ」から取り込めます）
            </p>
          )}
          <p className="ui-note">
            {source === 'drive'
              ? '共有アカウントのGoogleドライブにある、名前に「廃棄物」を含むスプレッドシートを新しい順に表示しています。ファイル名に「2026年9月」のような年月があれば、対象月もそれに合わせます。'
              : '「日・曜日・1〜7階・合計」の列を持つ、添付の記入用シートと同じ形式のExcelファイルを選んでください。'}
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
            <button type="button" className="btn-primary" onClick={handleSubmit} disabled={busy || !canSubmit}>
              {busy ? busyLabel || '処理中…' : '取り込む'}
            </button>
          </div>
        </div>
      </div>
      <PdfBusyOverlay show={busy} label={busyLabel || '処理しています…'} />
    </div>
  )
}
