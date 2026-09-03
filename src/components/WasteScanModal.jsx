import { useEffect, useRef, useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { IconCamera, IconChevronLeft, IconChevronRight, IconFolder } from './Icons'
import { prepareImage } from '../lib/imageResize'
import { uploadWasteScan, recognizeWasteScan } from '../lib/waste'
import { shiftMonth } from '../lib/reports'

// スキャン取込（docs/waste-plan.md 5-2）。記入済みの月次シート1枚を丸ごと写真として
// アップロードし、Claude Vision で日×階の実測値を読み取る（手動トリガー）。
// 読み取り結果は is_confirmed=false の下書きとして保存され、閉じた後の一覧（月別表示）
// で人が確認・訂正する（この画面自体には結果のプレビューは出さない）。
export default function WasteScanModal({ defaultMonth, onClose, onDone }) {
  useBodyScrollLock()

  const [month, setMonth] = useState(defaultMonth)
  const [file, setFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyLabel, setBusyLabel] = useState('')
  const [error, setError] = useState('')
  const cameraRef = useRef(null)
  const fileRef = useRef(null)

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  function handlePick(fileList) {
    const picked = fileList?.[0]
    if (!picked) return
    setError('')
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(picked)
    setPreviewUrl(URL.createObjectURL(picked))
  }

  async function handleSubmit() {
    if (!file) {
      setError('シートの写真を選んでください')
      return
    }
    setBusy(true)
    setError('')
    try {
      setBusyLabel('画像をアップロード中…')
      const prepared = await prepareImage(file, 'waste')
      const scan = await uploadWasteScan({ targetMonth: month, file: prepared.file })
      setBusyLabel('読み取り中…')
      const { readCount } = await recognizeWasteScan(scan.id)
      onDone(month, readCount)
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
          <h2>スキャン取込</h2>
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
            <label>記入済みシートの写真</label>
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => {
                handlePick(e.target.files)
                e.target.value = ''
              }}
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                handlePick(e.target.files)
                e.target.value = ''
              }}
            />
            {previewUrl ? (
              <img src={previewUrl} alt="選択したシート" className="waste-scan-preview" />
            ) : (
              <p className="ui-note">
                1ヶ月分の記入済みシートを1枚にまとめて撮影・スキャンしてください。文字がはっきり写るよう、
                明るい場所で真上から撮影することをおすすめします。
              </p>
            )}
            <div className="photo-add-icon-row">
              <button
                type="button"
                className="icon-btn-camera"
                onClick={() => cameraRef.current?.click()}
                aria-label="撮影して選ぶ"
                title="撮影して選ぶ"
                disabled={busy}
              >
                <IconCamera size={20} />
              </button>
              <button
                type="button"
                className="icon-btn-folder"
                onClick={() => fileRef.current?.click()}
                aria-label="ライブラリから選ぶ"
                title="ライブラリから選ぶ"
                disabled={busy}
              >
                <IconFolder size={20} />
              </button>
            </div>
          </div>

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
              {busy ? busyLabel || '処理中…' : '読み取る'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
