import { useEffect, useMemo, useRef, useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { IconCamera, IconChevronLeft, IconChevronRight, IconFolder } from './Icons'
import PdfBusyOverlay from './PdfBusyOverlay'
import { prepareImage } from '../lib/imageResize'
import {
  WASTE_FLOORS,
  importWasteRecords,
  recognizeWastePhoto,
  wastePhotoRowCheck,
  wastePhotoRowSum,
} from '../lib/waste'
import { shiftMonth, weekdayInfo } from '../lib/reports'
import { buildWasteChatPrompt, parseWasteChatText } from '../lib/wasteChatImport'
import { copyText } from '../lib/secureShares'

// 手書きの集計表の写真読み取り（2026-11-11〜。docs/waste-plan.md 10-10）。
// 日々の記録が紙の手書きになったため、記入済みの「廃棄物実測集計表」を撮影してAIで読み取る。
//   1. 対象月を選び、表全体を撮影（またはライブラリから選ぶ）→「読み取る」
//   2. 読み取った値をこの画面の表で確認・訂正する。手書きの「合計」欄も読み取り、各階の和と
//      合わない日は赤、AIが自信のない欄は黄色で示す（写真・現物と見比べて直す）
//   3.「登録する」で Excel取込と同じ /api/waste/records/import に送り、未確認の下書きとして保存
//      （一覧で最終確認して「この月を確認済みにする」の流れは従来どおり）
// 写真はAIに送るだけで、どこにも保存しない。
//
// 2026-11-11 追記（docs/waste-plan.md 10-11）: APIクレジットを節約したい・撮り直すたびに費用がかかる、
// との依頼で、**Claudeのチャット（定額）で読み取った結果を貼り付ける方法を既定**にした。
// 依頼文をコピー → チャットに写真と一緒に送る → 返ってきたCSVを貼り付け →「確認画面へ」。
// 確認画面（2.〜3.）は共通。アプリでの読み取り（クレジット使用）は切り替えで残している。

function toCellText(v) {
  return v === null || v === undefined ? '' : String(v)
}

// 入力欄の文字列 → 数値（空欄は null、数値でなければ NaN）
function parseCell(text) {
  const t = String(text ?? '').trim()
  if (t === '') return null
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN
  return Number(t)
}

export default function WastePhotoImportModal({ defaultMonth, holidays = {}, onClose, onDone }) {
  useBodyScrollLock()

  const [month, setMonth] = useState(defaultMonth)
  // 'chat'＝チャットの結果を貼り付け（既定・追加費用なし）／'api'＝アプリで読み取り（APIクレジット使用）
  const [mode, setMode] = useState('chat')
  const [pasted, setPasted] = useState('')
  const [copyState, setCopyState] = useState('') // '' | 'copied' | 'failed'
  const [file, setFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  // 読み取り結果（編集用に文字列で持つ）: [{ day, floors: {'1': '2.77', ...}, total: '11.83', unclear: [] }]
  const [rows, setRows] = useState(null)
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

  async function handleRecognize() {
    if (!file) {
      setError('集計表の写真を撮影するか、選んでください')
      return
    }
    setBusy(true)
    setError('')
    try {
      setBusyLabel('写真を準備中…')
      const prepared = await prepareImage(file, 'waste')
      setBusyLabel('AIで読み取り中…（1分ほどかかることがあります）')
      const result = await recognizeWastePhoto(prepared.file, month)
      setRows(
        result.map((r) => ({
          day: r.day,
          floors: Object.fromEntries(WASTE_FLOORS.map((f) => [f, toCellText(r.floors?.[f])])),
          total: toCellText(r.total),
          unclear: Array.isArray(r.unclear) ? r.unclear : [],
        }))
      )
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
      setBusyLabel('')
    }
  }

  const chatPrompt = useMemo(() => buildWasteChatPrompt(month), [month])

  async function handleCopyPrompt() {
    const ok = await copyText(chatPrompt)
    setCopyState(ok ? 'copied' : 'failed')
  }

  function handleParsePasted() {
    setError('')
    try {
      setRows(parseWasteChatText(pasted, month))
    } catch (err) {
      setError(err.message)
    }
  }

  function updateCell(day, key, value) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.day !== day) return r
        // 人が触った欄は「自信のない欄」の印を外す
        const unclear = r.unclear.filter((u) => u !== key)
        if (key === 'total') return { ...r, total: value, unclear }
        return { ...r, floors: { ...r.floors, [key]: value }, unclear }
      })
    )
  }

  // 行ごとの突き合わせ結果と、登録する値の集計
  const checked = useMemo(() => {
    if (!rows) return null
    let invalid = 0
    let count = 0
    const mismatchDays = []
    const list = rows.map((r) => {
      const floors = {}
      for (const f of WASTE_FLOORS) {
        const v = parseCell(r.floors[f])
        if (Number.isNaN(v) || (v !== null && v > 999.99)) invalid += 1
        else if (v !== null) count += 1
        floors[f] = Number.isNaN(v) ? null : v
      }
      const total = parseCell(r.total)
      const status = wastePhotoRowCheck(floors, Number.isNaN(total) ? null : total)
      if (status === 'mismatch') mismatchDays.push(r.day)
      return { ...r, sum: wastePhotoRowSum(floors), status }
    })
    const unclearCount = rows.reduce((n, r) => n + r.unclear.length, 0)
    return { list, invalid, count, mismatchDays, unclearCount }
  }, [rows])

  async function handleRegister() {
    if (!checked) return
    if (checked.invalid > 0) {
      setError('数値として読めない欄があります（赤い枠の欄を直してください）')
      return
    }
    const payload = []
    for (const r of rows) {
      const recordDate = `${month}-${String(r.day).padStart(2, '0')}`
      for (const f of WASTE_FLOORS) {
        const v = parseCell(r.floors[f])
        if (v === null || Number.isNaN(v)) continue
        payload.push({ record_date: recordDate, floor: f, weight_kg: Math.round(v * 100) / 100 })
      }
    }
    if (payload.length === 0) {
      setError('登録する値がありません')
      return
    }
    setBusy(true)
    setBusyLabel('登録中…')
    setError('')
    try {
      const { imported, removed } = await importWasteRecords(payload, month)
      onDone(month, imported, removed)
    } catch (err) {
      setError(err.message)
      setBusy(false)
      setBusyLabel('')
    }
  }

  const monthLabel = `${month.replace('-', '年')}月`

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={busy ? undefined : onClose}>
      <div className={`ui-modal${rows ? ' is-lg' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h2>{rows ? `読み取り結果（${monthLabel}）` : '手書きの集計表を読み取る'}</h2>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる" disabled={busy}>
            ×
          </button>
        </div>

        {!rows ? (
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
                <span className="inspection-month-label">{monthLabel}</span>
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
              <label>読み取り方法</label>
              <div>
                <div className="ui-segmented" role="group" aria-label="読み取り方法">
                  <button
                    type="button"
                    className={`ui-segmented-btn${mode === 'chat' ? ' is-active' : ''}`}
                    aria-pressed={mode === 'chat'}
                    onClick={() => {
                      setMode('chat')
                      setError('')
                    }}
                    disabled={busy}
                  >
                    チャットで読み取る
                  </button>
                  <button
                    type="button"
                    className={`ui-segmented-btn${mode === 'api' ? ' is-active' : ''}`}
                    aria-pressed={mode === 'api'}
                    onClick={() => {
                      setMode('api')
                      setError('')
                    }}
                    disabled={busy}
                  >
                    アプリで読み取る
                  </button>
                </div>
              </div>
            </div>

            {mode === 'chat' ? (
              <>
                <div className="ui-field">
                  <label>① 依頼文をコピーして、Claudeのチャットに集計表の写真と一緒に送る</label>
                  <textarea className="ui-textarea waste-chat-prompt" value={chatPrompt} readOnly rows={5} />
                  <div className="waste-chat-copy-row">
                    <button type="button" className="btn-plain" onClick={handleCopyPrompt}>
                      依頼文をコピー
                    </button>
                    {copyState === 'copied' && <span className="ui-note">コピーしました</span>}
                    {copyState === 'failed' && (
                      <span className="ui-note">コピーできませんでした。上の欄を長押し（PCは全選択）してコピーしてください</span>
                    )}
                  </div>
                  <p className="ui-note">
                    対象月が依頼文に入っています。月を変えたらコピーし直してください。チャットでの読み直しは何度でも追加費用なしでできます。
                  </p>
                </div>
                <div className="ui-field">
                  <label htmlFor="waste-chat-paste">② チャットが返したCSV（「日,1F,2F,…」の表）を貼り付ける</label>
                  <textarea
                    id="waste-chat-paste"
                    className="ui-textarea waste-chat-paste"
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    rows={8}
                    placeholder={'日,1F,2F,3F,4F,5F,6F,7F,合計\n1,2.77,2.1,,1.07,2.71,,3.1,11.83\n…'}
                  />
                </div>
              </>
            ) : (
            <div className="ui-field">
              <label>記入済みの集計表の写真</label>
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
              {previewUrl && <img src={previewUrl} alt="選んだ集計表" className="waste-photo-preview" />}
              <div className="photo-add-icon-row">
                <button
                  type="button"
                  className="icon-btn-camera"
                  onClick={() => cameraRef.current?.click()}
                  aria-label="撮影する"
                  title="撮影する"
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
              <p className="ui-note">
                1ヶ月分の表を1枚に収めて、明るい場所で真上から撮影してください（影や反射が数字にかからないように）。
                写真はAIの読み取りにだけ使い、保存しません。読み取った値は次の画面で確認・訂正してから登録します。
                <strong>この方法はAnthropicのAPIクレジットを使います（1回 約8〜25円。読み直すたびにかかります）。</strong>
              </p>
            </div>
            )}

            {error && (
              <p className="dashboard-error dashboard-banner" role="alert">
                {error}
              </p>
            )}
          </div>
        ) : (
          <div className="ui-modal-body is-stacked">
            <p className={`dashboard-banner${checked.mismatchDays.length > 0 ? ' dashboard-error' : ''}`}>
              {checked.mismatchDays.length > 0
                ? `手書きの「合計」欄と各階の和が合わない日があります: ${checked.mismatchDays.map((d) => `${d}日`).join('・')}（赤い行）。写真・現物と見比べて直してください。`
                : '全ての日で、手書きの「合計」欄と各階の和が一致しました。'}
              {checked.unclearCount > 0 && ` 黄色の欄はAIが判読に自信のない欄です（${checked.unclearCount}か所）。`}
            </p>

            <div className="ui-table-wrap waste-photo-table-wrap">
              <table className="ui-table waste-table waste-photo-table">
                <thead>
                  <tr>
                    <th>日</th>
                    <th>曜</th>
                    {WASTE_FLOORS.map((f) => (
                      <th key={f}>{f}F</th>
                    ))}
                    <th title="1F〜7Fの和（自動計算）">各階の和</th>
                    <th title="手書きの「合計」欄の読み取り値">合計欄</th>
                  </tr>
                </thead>
                <tbody>
                  {checked.list.map((r) => {
                    const date = `${month}-${String(r.day).padStart(2, '0')}`
                    const wd = weekdayInfo(date, holidays)
                    return (
                      <tr key={r.day} className={r.status === 'mismatch' ? 'is-mismatch' : ''}>
                        <td className={`waste-day ${wd.className}`}>{r.day}</td>
                        <td className={`waste-day ${wd.className}`}>{wd.label}</td>
                        {WASTE_FLOORS.map((f) => (
                          <td key={f} className="waste-col-cell">
                            <input
                              type="text"
                              inputMode="decimal"
                              className={`waste-photo-input${r.unclear.includes(f) ? ' is-unclear' : ''}${
                                Number.isNaN(parseCell(r.floors[f])) ? ' is-invalid' : ''
                              }`}
                              value={r.floors[f]}
                              onChange={(e) => updateCell(r.day, f, e.target.value)}
                              aria-label={`${r.day}日 ${f}F`}
                              disabled={busy}
                            />
                          </td>
                        ))}
                        <td className="is-numeric waste-photo-sum">{r.sum === null ? '' : r.sum.toFixed(2)}</td>
                        <td className="waste-col-cell">
                          <input
                            type="text"
                            inputMode="decimal"
                            className={`waste-photo-input is-total${r.unclear.includes('total') ? ' is-unclear' : ''}${
                              Number.isNaN(parseCell(r.total)) ? ' is-invalid' : ''
                            }`}
                            value={r.total}
                            onChange={(e) => updateCell(r.day, 'total', e.target.value)}
                            aria-label={`${r.day}日 合計欄`}
                            disabled={busy}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="ui-note">
              単位: kg。「合計欄」は突き合わせのためだけに使い、登録はしません（月別一覧の合計は1F〜7Fから自動計算）。
              登録すると未確認の下書きとして保存され、この月の未確認の値のうち今回空欄の欄は削除されます。
            </p>

            {error && (
              <p className="dashboard-error dashboard-banner" role="alert">
                {error}
              </p>
            )}
          </div>
        )}

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start">
            {rows && (
              <button
                type="button"
                className="btn-plain"
                onClick={() => {
                  setRows(null)
                  setError('')
                }}
                disabled={busy}
              >
                {mode === 'chat' ? '貼り付けに戻る' : '撮り直す'}
              </button>
            )}
          </div>
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose} disabled={busy}>
              キャンセル
            </button>
            {!rows && mode === 'chat' ? (
              <button type="button" className="btn-primary" onClick={handleParsePasted} disabled={!pasted.trim()}>
                確認画面へ
              </button>
            ) : !rows ? (
              <button type="button" className="btn-primary" onClick={handleRecognize} disabled={busy || !file}>
                {busy ? busyLabel || '処理中…' : '読み取る（クレジット使用）'}
              </button>
            ) : (
              <button
                type="button"
                className="btn-primary"
                onClick={handleRegister}
                disabled={busy || checked.count === 0}
              >
                {busy ? busyLabel || '処理中…' : `登録する（${checked.count}件）`}
              </button>
            )}
          </div>
        </div>
      </div>
      <PdfBusyOverlay show={busy} label={busyLabel || '処理しています…'} />
    </div>
  )
}
