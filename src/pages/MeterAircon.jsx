import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import { defaultMeterMonth, fetchMeterAircon, importMeterAircon, meterMonthLabel } from '../lib/meter'
import { acCsvWarnings, decodeAcCsv, groupAcUsage, periodLabel } from '../lib/meterAircon'
import { parseAcControllerCsv } from '../lib/meterCsv'
import { formatValue } from '../lib/meterMonth'
import './Dashboard.css'
import './Meter.css'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// 空調データ（Phase 3。2026-11-10〜。docs/meter-plan.md 5章。FileMaker の「空調データ」「空調データの取込」）。
// 空調集中コントローラから USB に書き出した CSV（例 20260901_20260930.csv。9/1〜9/30 の使用分＝10月度）を選ぶかドラッグすると、
// 中身を確かめてから取り込む。室内機の割当てメータは取り込んだときの検針マスタ（空調機タブ）のもの。
// マスタの割当てを直したら、同じ CSV をもう一度取り込めば合わせ直せる（FileMaker の「割当先メータ最新化」）
export default function MeterAircon() {
  const params = useParams()
  const navigate = useNavigate()
  const month = MONTH_RE.test(params.month || '') ? params.month : defaultMeterMonth()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(null) // 選んだ CSV の中身 { fileName, parsed, warnings }
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState('')
  const [dragging, setDragging] = useState(false)
  const [open, setOpen] = useState(() => new Set())

  const load = useCallback(async () => {
    setError('')
    try {
      setData(await fetchMeterAircon(month))
    } catch (err) {
      setError(err.message)
    }
  }, [month])

  useEffect(() => {
    setData(null)
    load()
  }, [load])

  const summary = useMemo(() => (data ? groupAcUsage(data) : null), [data])
  const period = data?.usage?.find((u) => u.period_start) || null

  async function readFile(file) {
    if (!file) return
    setError('')
    setResult('')
    try {
      const parsed = parseAcControllerCsv(decodeAcCsv(await file.arrayBuffer()))
      if (parsed.units.length === 0) throw new Error('室内機の行がありません')
      setPending({ fileName: file.name, parsed, warnings: acCsvWarnings(parsed, month) })
    } catch (err) {
      setPending(null)
      setError(`${file.name}: ${err.message}`)
    }
  }

  async function handleImport() {
    if (!pending) return
    setImporting(true)
    setError('')
    try {
      const { parsed } = pending
      const res = await importMeterAircon(parsed)
      const notes = []
      if (res.unassigned?.length) notes.push(`割当てメータの無い室内機 ${res.unassigned.length}台（${res.unassigned.join('・')}）`)
      setResult(`${meterMonthLabel(parsed.month)}の空調データを ${res.saved}台分取り込みました。${notes.length ? `注意: ${notes.join('、')}` : ''}`)
      setPending(null)
      if (parsed.month !== month) navigate(`/meter/${parsed.month}/aircon`)
      else await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  function toggle(meterNo) {
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(meterNo)) next.delete(meterNo)
      else next.add(meterNo)
      return next
    })
  }

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
          readFile(e.dataTransfer.files?.[0])
        }}
      >
        <FeatureHeader
          title={`${meterMonthLabel(month)}の空調データ`}
          leading={
            <button type="button" className="btn-plain" onClick={() => navigate(`/meter/${month}`)}>
              一覧へ
            </button>
          }
          actions={
            <>
              <button type="button" className="btn-plain" onClick={() => navigate(`/meter/${month}/report`)}>
                出力と報告
              </button>
              <label className={`btn-primary meter-file-btn${importing ? ' is-disabled' : ''}`}>
                CSV を選ぶ
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => {
                    readFile(e.target.files?.[0])
                    e.target.value = ''
                  }}
                  disabled={importing}
                  hidden
                />
              </label>
            </>
          }
        />

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        <div className="meter-stack">
          <p className="ui-note">
            空調集中コントローラから USB に書き出した CSV（例: 20260901_20260930.csv）を「CSV を選ぶ」で選ぶか、この画面へドラッグしてください。
            9/1〜9/30 の使用分は 10月度として取り込みます。同じ月度をもう一度取り込むと置き換わります
            （検針マスタで室内機の割当てを直したときも、取り込み直せば合わせ直せます）。
          </p>

          {pending && (
            <section className="ui-card">
              <h3 className="ui-card-title">取り込む内容の確認</h3>
              <dl className="meter-facts">
                <div>
                  <dt>ファイル</dt>
                  <dd>{pending.fileName}</dd>
                </div>
                <div>
                  <dt>期間</dt>
                  <dd>{periodLabel(pending.parsed.periodStart, pending.parsed.days)}</dd>
                </div>
                <div>
                  <dt>検針月度</dt>
                  <dd>{meterMonthLabel(pending.parsed.month)}</dd>
                </div>
                <div>
                  <dt>室内機</dt>
                  <dd>{pending.parsed.units.length}台</dd>
                </div>
                <div>
                  <dt>昼間電力の合計</dt>
                  <dd>{formatValue(pending.parsed.units.reduce((a, u) => a + (u.day_wh || 0), 0))} Wh</dd>
                </div>
              </dl>
              {pending.warnings.length > 0 && (
                <ul className="meter-import-warnings">
                  {pending.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              {data?.usage?.length > 0 && pending.parsed.month === month && (
                <p className="ui-note">この月度にはすでに {data.usage.length}台分の空調データがあります。取り込むと置き換わります。</p>
              )}
              <div className="meter-import-actions">
                <button type="button" className="btn-primary" onClick={handleImport} disabled={importing}>
                  {importing ? '取り込み中…' : `${meterMonthLabel(pending.parsed.month)}として取り込む`}
                </button>
                <button type="button" className="btn-plain" onClick={() => setPending(null)} disabled={importing}>
                  やめる
                </button>
              </div>
            </section>
          )}

          {result && <p className="meter-check-ok">{result}</p>}

          {!data && !error ? (
            <p className="dashboard-loading">読み込み中…</p>
          ) : !data ? null : data.usage.length === 0 ? (
            <p className="ui-empty">{meterMonthLabel(month)}の空調データはまだありません。</p>
          ) : (
            <>
              <div className="meter-list-options">
                <span className="meter-progress">
                  期間 <strong>{periodLabel(period?.period_start, period?.period_days) || '（FileMaker から移行）'}</strong>・室内機{' '}
                  <strong>{data.usage.length}</strong>台・メータ <strong>{summary.groups.length}</strong>件・昼間電力の合計{' '}
                  <strong>{formatValue(summary.total)}</strong> Wh
                </span>
              </div>
              {summary.mismatched > 0 && (
                <ul className="meter-import-warnings">
                  <li>
                    検針マスタの今の割当てと違う室内機が {summary.mismatched}台あります（下の表の「マスタでは」）。
                    今の割当てで出力するなら、同じ CSV をもう一度取り込んでください。
                  </li>
                </ul>
              )}
              {summary.unassigned.length > 0 && (
                <ul className="meter-import-warnings is-danger">
                  <li>
                    割当てメータの無い室内機が {summary.unassigned.length}台あります（
                    {summary.unassigned.map((u) => u.unit_no).join('・')}）。この電力は出力に入りません。
                    検針マスタの「空調機」で割り当ててから取り込み直してください。
                  </li>
                </ul>
              )}
              <div className="ui-table-wrap meter-sticky-wrap">
                <table className="ui-table meter-table meter-aircon-table">
                  <thead>
                    <tr>
                      <th>メータ</th>
                      <th>テナント・貸室</th>
                      <th className="is-numeric">台数</th>
                      <th className="is-numeric">昼間電力（Wh）</th>
                      <th className="is-numeric">請求用（kWh）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.groups.map((g) => (
                      <Fragment key={g.meterNo}>
                        <tr className="meter-row" onClick={() => toggle(g.meterNo)} title="室内機の内訳を開く・閉じる">
                          <td className="meter-no">
                            {open.has(g.meterNo) ? '▾ ' : '▸ '}
                            {g.meterNo}
                            {!g.meter && <span className="ui-badge is-danger">マスタに無い</span>}
                          </td>
                          <td>
                            <strong>{g.tenant?.short_name || g.tenant?.name || ''}</strong>
                            <div className="meter-sub">{g.meter?.room_name || ''}</div>
                          </td>
                          <td className="is-numeric">{g.units.length}</td>
                          <td className="is-numeric meter-strong">{formatValue(g.wh)}</td>
                          <td className="is-numeric meter-strong">{formatValue(g.kwh)}</td>
                        </tr>
                        {open.has(g.meterNo) &&
                          g.units.map((u) => (
                            <tr key={u.unit_no} className="meter-aircon-unit">
                              <td>　空調機 {u.unit_no}</td>
                              <td className="meter-sub">
                                {u.address}
                                {u.changed && (
                                  <span className="ui-badge is-warn">マスタでは {u.currentMeterNo || '割当てなし'}</span>
                                )}
                              </td>
                              <td />
                              <td className="is-numeric">{formatValue(u.day_wh)}</td>
                              <td />
                            </tr>
                          ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
