import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import { IconDownload } from '../components/Icons'
import MeterMailCard from '../components/MeterMailCard'
import {
  activeMeters,
  defaultMeterMonth,
  fetchMeterOutputData,
  fetchMeterRepairData,
  meterMonthLabel,
} from '../lib/meter'
import { formatValue } from '../lib/meterMonth'
import { buildMeterOutput, compareMeterOutput } from '../lib/meterOutput'
import {
  buildMeterDataXlsx,
  buildRepairDataXlsx,
  fetchXlsxTemplate,
  meterDataFileName,
  meterFileMonth,
  repairDataFileName,
} from '../lib/meterXlsx'
import { downloadBlob } from '../lib/xlsxWrite'
import { readFirstSheetRows } from '../lib/xlsxRead'
import './Dashboard.css'
import './Meter.css'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

function formatCell(v) {
  if (v == null || v === '') return '（空）'
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6)
  return String(v)
}

// 出力と報告（Phase 3。2026-11-10〜。docs/meter-plan.md 5章・6章。FileMaker の「Excel出力」「報告」）。
//   ① 検針データ_yyyy年mm月分.xlsx（47列）… 検針値・空調データ・マスタから組み立てる。FileMaker の xlsx と突き合わせもできる
//   ② 修理データ_yyyy年mm月分.xlsx（7列）… 検針月度の前月にテナントへ設置した備品（蛍光ランプ）
//   ③ 提出メール … 上の2つを添付した下書きを Gmail（共有アドレス）に作る。送信は Gmail で確かめてから手で（Q7・D2）
export default function MeterReport() {
  const params = useParams()
  const navigate = useNavigate()
  const month = MONTH_RE.test(params.month || '') ? params.month : defaultMeterMonth()
  const [data, setData] = useState(null)
  const [repair, setRepair] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [compared, setCompared] = useState(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const [out, rep] = await Promise.all([fetchMeterOutputData(month), fetchMeterRepairData(month)])
      setData(out)
      setRepair(rep)
    } catch (err) {
      setError(err.message)
    }
  }, [month])

  useEffect(() => {
    setData(null)
    setRepair(null)
    setCompared(null)
    load()
  }, [load])

  const output = useMemo(
    () =>
      data
        ? buildMeterOutput({
            month,
            tenants: data.tenants,
            meters: data.meters,
            readings: data.readings,
            acUsage: data.acUsage,
            oaCoefficient: data.constants.oa_coefficient,
          })
        : null,
    [data, month]
  )

  const status = useMemo(() => {
    if (!data) return null
    const targets = activeMeters(data.meters)
    const read = new Set(data.readings.filter((r) => r.month === month && r.value != null).map((r) => r.meter_id))
    const missing = targets.filter((m) => !read.has(m.id))
    return { targets: targets.length, entered: targets.length - missing.length, missing, acUnits: data.acUsage.length }
  }, [data, month])

  async function makeFiles() {
    const [meterTpl, repairTpl] = await Promise.all([fetchXlsxTemplate('meter-data.xlsx'), fetchXlsxTemplate('meter-repair-data.xlsx')])
    return [
      { name: meterDataFileName(month), blob: await buildMeterDataXlsx(output, meterTpl) },
      { name: repairDataFileName(month), blob: await buildRepairDataXlsx(month, repair.billing, repairTpl) },
    ]
  }

  async function run(label, fn) {
    setBusy(label)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const downloadMeter = () =>
    run('meter', async () => {
      const tpl = await fetchXlsxTemplate('meter-data.xlsx')
      downloadBlob(await buildMeterDataXlsx(output, tpl), meterDataFileName(month))
    })

  const downloadRepair = () =>
    run('repair', async () => {
      const tpl = await fetchXlsxTemplate('meter-repair-data.xlsx')
      downloadBlob(await buildRepairDataXlsx(month, repair.billing, tpl), repairDataFileName(month))
    })

  const compareWith = (file) =>
    run('compare', async () => {
      const rows = await readFirstSheetRows(await file.arrayBuffer())
      setCompared({ fileName: file.name, ...compareMeterOutput(output, rows) })
    })

  const loading = (!data || !repair) && !error
  const ready = !!(output && repair)

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-wide app-scroll">
        <FeatureHeader
          title={`${meterMonthLabel(month)}の出力と報告`}
          leading={
            <button type="button" className="btn-plain" onClick={() => navigate(`/meter/${month}`)}>
              一覧へ
            </button>
          }
          actions={
            <button type="button" className="btn-plain" onClick={() => navigate(`/meter/${month}/aircon`)}>
              空調データ
            </button>
          }
        />

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : !ready ? null : (
          <div className="meter-stack">
            <section className="ui-card meter-report-card">
              <h3 className="ui-card-title">出力の前の確認</h3>
              <dl className="meter-facts">
                <div>
                  <dt>検針値</dt>
                  <dd>
                    {status.entered} / {status.targets}台
                  </dd>
                </div>
                <div>
                  <dt>空調データ</dt>
                  <dd>{status.acUnits ? `${status.acUnits}台` : 'まだありません'}</dd>
                </div>
                <div>
                  <dt>修理データ（{Number(repair.work_month.slice(5))}月の設置）</dt>
                  <dd>{repair.billing.length}件</dd>
                </div>
              </dl>
              {(status.missing.length > 0 || status.acUnits === 0) && (
                <ul className="meter-import-warnings">
                  {status.missing.length > 0 && (
                    <li>
                      当月値の入っていないメータが {status.missing.length}台あります（{status.missing.map((m) => m.meter_no).join('・')}）。
                      このまま出すと使用量が0になります。
                    </li>
                  )}
                  {status.acUnits === 0 && (
                    <li>
                      空調データがまだありません。このまま出すと空調の列が空になり、請求書Excelの空調の金額が0になります。
                      先に「空調データ」で CSV を取り込んでください。
                    </li>
                  )}
                </ul>
              )}
            </section>

            <section className="ui-card meter-report-card">
              <h3 className="ui-card-title">検針データ（{meterDataFileName(month)}）</h3>
              <p className="ui-note">
                {output.rows.length}行 × {output.columns.length}列。FileMaker の「Excel出力：検針＆空調」と同じ列・同じ並びです。
                並行運用の間は、FileMaker が出した同じ月の xlsx を選ぶと全セルを突き合わせます。
              </p>
              <div className="meter-report-actions">
                <button type="button" className="btn-plain" onClick={downloadMeter} disabled={!!busy}>
                  <IconDownload size={18} />
                  {busy === 'meter' ? '作成中…' : 'ダウンロード'}
                </button>
                <label className={`btn-plain meter-file-btn${busy ? ' is-disabled' : ''}`}>
                  {busy === 'compare' ? '確認中…' : 'FileMaker の xlsx と突き合わせる'}
                  <input
                    type="file"
                    accept=".xlsx"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      e.target.value = ''
                      if (f) compareWith(f)
                    }}
                  />
                </label>
              </div>
              {compared &&
                (compared.problems.length === 0 ? (
                  <p className="meter-check-ok">
                    {compared.fileName} と {compared.cells}セルすべて一致しました。
                  </p>
                ) : (
                  <>
                    <p className="meter-check-ng">
                      {compared.fileName} と {compared.problems.length}セル違います（{compared.cells}セル中）。
                    </p>
                    <div className="ui-table-wrap">
                      <table className="ui-table meter-check-table">
                        <thead>
                          <tr>
                            <th>行</th>
                            <th>メータ</th>
                            <th>列</th>
                            <th>FileMaker</th>
                            <th>アプリ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {compared.problems.slice(0, 100).map((p) => (
                            <tr key={`${p.row}-${p.col}`}>
                              <td className="is-numeric">{p.row}</td>
                              <td>{p.meterNo}</td>
                              <td>
                                {p.col}. {p.column}
                              </td>
                              <td>{formatCell(p.expected)}</td>
                              <td>{formatCell(p.actual)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ))}
            </section>

            <section className="ui-card meter-report-card">
              <h3 className="ui-card-title">修理データ（{repairDataFileName(month)}）</h3>
              <p className="ui-note">
                {meterFileMonth(repair.work_month)}に備品の出庫で「テナント設置」にした分（無償交換を除く）を、請求先と備品ごとに合計したものです。
              </p>
              {repair.billing.length === 0 ? (
                <p className="ui-empty">この月の設置はありません（見出しだけのファイルになります）。</p>
              ) : (
                <div className="ui-table-wrap">
                  <table className="ui-table meter-table">
                    <thead>
                      <tr>
                        <th>請求先コード</th>
                        <th>請求先</th>
                        <th>備品</th>
                        <th className="is-numeric">本数</th>
                        <th>設置日</th>
                      </tr>
                    </thead>
                    <tbody>
                      {repair.billing.map((b) => (
                        <tr key={`${b.tenant_code}-${b.item_no}`}>
                          <td>{b.tenant_code}</td>
                          <td>{b.tenant_name}</td>
                          <td>{b.item_name}</td>
                          <td className="is-numeric">{formatValue(b.quantity)}</td>
                          <td>{b.installation_summary}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="meter-report-actions">
                <button type="button" className="btn-plain" onClick={downloadRepair} disabled={!!busy}>
                  <IconDownload size={18} />
                  {busy === 'repair' ? '作成中…' : 'ダウンロード'}
                </button>
              </div>
            </section>

            <MeterMailCard
              kind="report"
              month={month}
              title="提出メール"
              note="上の xlsx 2つを添付した下書きを Gmail（共有アドレス）に作ります。送信はしません。Gmail で中身を確かめてから送ってください。"
              attachmentNames={[meterDataFileName(month), repairDataFileName(month)]}
              makeFiles={makeFiles}
            />
          </div>
        )}
      </div>
    </div>
  )
}
