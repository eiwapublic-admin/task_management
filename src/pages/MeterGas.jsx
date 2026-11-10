import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import AttachmentPreview from '../components/AttachmentPreview'
import FeatureHeader from '../components/FeatureHeader'
import { IconDocument } from '../components/Icons'
import MeterMailCard from '../components/MeterMailCard'
import PdfBusyOverlay from '../components/PdfBusyOverlay'
import PdfPreviewActions from '../components/PdfPreviewActions'
import { defaultMeterMonth, fetchMeterMonth, meterMonthLabel } from '../lib/meter'
import { buildGasSlipPdfFile, buildGasSlips, gasValue, jaDate, tenantLabel } from '../lib/meterGasPdf'
import { getReportPdfPreviewUrl } from '../lib/reports'
import './Dashboard.css'
import './Meter.css'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const SCAN_ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png'
const SCAN_RE = /\.(pdf|jpe?g|png)$/i
const SCAN_MAX = 5

function sizeLabel(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`
}

// ガス・水道（Phase 4。2026-11-10〜。docs/meter-plan.md 5章。FileMaker の「ガス・水道お渡し票」「ガス検針表の送付」）。
// 月の半ばにガス・水道を検針すると翌月度に入る（例: 10/16 の検針は 11月度）。値の入力は検針一覧で（写真の取込も同じ）。
//   ① お渡し票 … メータ検針報告書（テナント様用＋控を A4 縦1枚に）。プレビューから印刷・ダウンロード
//   ② ガス検針票メール … スキャンした検針票（PDF・画像）を添付した下書きを Gmail（共有アドレス）に作る。送信は人が Gmail で
export default function MeterGas() {
  const params = useParams()
  const navigate = useNavigate()
  const month = MONTH_RE.test(params.month || '') ? params.month : defaultMeterMonth()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null) // { blob, filename, url }
  const [scans, setScans] = useState([]) // 添付するスキャンの File
  const [dragging, setDragging] = useState(false)

  const load = useCallback(async () => {
    setError('')
    try {
      setData(await fetchMeterMonth(month))
    } catch (err) {
      setError(err.message)
    }
  }, [month])

  useEffect(() => {
    setData(null)
    setScans([])
    load()
  }, [load])

  const slips = useMemo(() => (data ? buildGasSlips({ ...data, month }) : null), [data, month])
  const missing = slips ? slips.flatMap((s) => s.rows.filter((r) => !r.entered).map((r) => r.meterNo)) : []

  async function makePdf() {
    setBusy(true)
    setError('')
    try {
      const file = await buildGasSlipPdfFile(month, slips)
      const url = await getReportPdfPreviewUrl(file.blob, file.filename, 'meter-gas')
      setPreview({ ...file, url })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function addScans(list) {
    const files = [...(list || [])]
    if (!files.length) return
    const bad = files.filter((f) => !SCAN_RE.test(f.name))
    if (bad.length) setError(`添付できるのは PDF・JPEG・PNG だけです（${bad.map((f) => f.name).join('・')}）`)
    else setError('')
    setScans((cur) => {
      const names = new Set(cur.map((f) => f.name))
      return [...cur, ...files.filter((f) => SCAN_RE.test(f.name) && !names.has(f.name))].slice(0, SCAN_MAX)
    })
  }

  const scanTotal = scans.reduce((a, f) => a + f.size, 0)
  const scanProblem = !scans.length
    ? 'スキャンした検針票を「検針票を選ぶ」で選んでください。'
    : scans.some((f) => f.size > 10 * 1024 * 1024)
      ? '1つ10MBまでです。大きいファイルを外してください。'
      : scanTotal > 25 * 1024 * 1024
        ? '添付の合計は25MBまでです。'
        : ''

  return (
    <div className="ui-page">
      <AppHeader />
      <div
        className={`ui-container is-wide app-scroll${dragging ? ' meter-drop-active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          addScans(e.dataTransfer.files)
        }}
      >
        <FeatureHeader
          title={`${meterMonthLabel(month)}のガス・水道`}
          leading={
            <button type="button" className="btn-plain" onClick={() => navigate(`/meter/${month}`)}>
              一覧へ
            </button>
          }
          actions={
            <button type="button" className="btn-plain" onClick={() => navigate(`/meter/${month}/report`)}>
              出力と報告
            </button>
          }
        />

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {!data && !error ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : !slips ? null : (
          <div className="meter-stack">
            <p className="ui-note">
              月の半ばのガス・水道の検針は翌月度に入ります（例: 10/16 の検針は 11月度）。写真の取込と値の入力は、この月度の一覧で行ってください。
            </p>

            <section className="ui-card meter-report-card">
              <h3 className="ui-card-title">お渡し票（メータ検針報告書）</h3>
              <p className="ui-note">テナント様用と控を A4 縦1枚に並べた PDF を作ります。プレビューから印刷・ダウンロードできます。</p>
              {slips.length === 0 ? (
                <p className="ui-empty">ガス・水道のメータがありません（検針マスタのメータで検針内容が「ガス」「水道」のもの）。</p>
              ) : (
                <>
                  {slips.map((s) => (
                    <div key={s.tenant?.id || s.rows[0].meterNo} className="meter-gas-slip">
                      <div className="meter-gas-slip-head">
                        <strong>{tenantLabel(s.tenant) || '（テナントなし）'} 様</strong>
                        <span className="meter-sub">検針日付 {jaDate(s.readOn) || '（未入力）'}</span>
                      </div>
                      <div className="ui-table-wrap">
                        <table className="ui-table meter-table">
                          <thead>
                            <tr>
                              <th>メータ</th>
                              <th className="is-numeric">今月の検針値（㎥）</th>
                              <th className="is-numeric">今月の使用量</th>
                              <th className="is-numeric">前月の使用量</th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.rows.map((r) => (
                              <tr key={r.meterNo}>
                                <td>
                                  {r.kind}
                                  <div className="meter-sub">{r.meterNo}</div>
                                </td>
                                <td className="is-numeric meter-strong">{r.entered ? gasValue(r.value) : '未入力'}</td>
                                <td className="is-numeric meter-strong">{r.usage != null ? gasValue(r.usage) : ''}</td>
                                <td className="is-numeric">{r.prevUsage != null ? gasValue(r.prevUsage) : ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                  {missing.length > 0 && (
                    <ul className="meter-import-warnings">
                      <li>
                        当月値の入っていないメータがあります（{missing.join('・')}）。この月度の一覧で写真を取り込み、値を入れてから作ってください。
                      </li>
                    </ul>
                  )}
                  <div className="meter-report-actions">
                    <button type="button" className="btn-primary" onClick={makePdf} disabled={busy}>
                      <IconDocument size={18} />
                      {busy ? '作成中…' : 'お渡し票の PDF を作る'}
                    </button>
                  </div>
                </>
              )}
            </section>

            <MeterMailCard
              kind="gas"
              month={month}
              title="ガス検針票の送付メール"
              note="スキャンしたガス検針票（PDF・JPEG・PNG）を添付した下書きを Gmail（共有アドレス）に作ります。送信はしません。Gmail で中身を確かめてから送ってください。"
              attachmentNames={scans.map((f) => f.name)}
              makeFiles={async () => scans.map((f) => ({ blob: f, name: f.name }))}
              disabledReason={scanProblem}
            >
              <div className="meter-report-actions">
                <label className="btn-plain meter-file-btn">
                  検針票を選ぶ
                  <input
                    type="file"
                    accept={SCAN_ACCEPT}
                    multiple
                    hidden
                    onChange={(e) => {
                      addScans(e.target.files)
                      e.target.value = ''
                    }}
                  />
                </label>
                <span className="meter-sub">この画面へドラッグしても追加できます（{SCAN_MAX}つまで）</span>
              </div>
              {scans.length > 0 && (
                <ul className="meter-gas-scans">
                  {scans.map((f) => (
                    <li key={f.name}>
                      <span>{f.name}</span>
                      <span className="meter-sub">{sizeLabel(f.size)}</span>
                      <button type="button" className="btn-plain" onClick={() => setScans((cur) => cur.filter((x) => x !== f))}>
                        外す
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </MeterMailCard>
          </div>
        )}
      </div>
      <PdfBusyOverlay show={busy} />
      {preview && (
        <AttachmentPreview
          attachment={{ filename: preview.filename, mimeType: 'application/pdf' }}
          url={preview.url}
          onClose={() => setPreview(null)}
          headerAction={<PdfPreviewActions blob={preview.blob} filename={preview.filename} />}
        />
      )}
    </div>
  )
}
