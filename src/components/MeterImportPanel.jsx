import { useMemo, useState } from 'react'
import { MIGRATION_FILES, readMigrationCsv } from '../lib/meterCsv'
import { prepareMigration } from '../lib/meterMigration'
import { buildMeterOutput, compareMeterOutput } from '../lib/meterOutput'
import { readFirstSheetRows } from '../lib/xlsxRead'
import { fetchMeterOutputData, importMeterRecords } from '../lib/meter'

// 取り込む順番（後の種類は前の種類で入ったテナント・メータを引く）
const IMPORT_ORDER = ['tenants', 'meters', 'ac_units', 'readings', 'ac_usage']
const CHUNK = 500
const LABELS = Object.fromEntries(MIGRATION_FILES.map((f) => [f.kind, f.label]))

function formatCell(v) {
  if (v == null || v === '') return '（空）'
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6)
  return String(v)
}

// 検針マスタ画面の「取込・照合」（2026-10-20〜。docs/meter-plan.md 8章 Phase 1・5）。
// ① FileMaker から書き出した CSV 5本を取り込む（何度流しても同じ結果。アプリで入力した月は上書きしない）
// ② 取り込んだデータで「検針データ_yyyy年mm月分」を組み立て、FileMaker が出した xlsx と全セルを突き合わせる
export default function MeterImportPanel({ counts, onImported }) {
  const [files, setFiles] = useState({})
  const [readErrors, setReadErrors] = useState([])
  const [progress, setProgress] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)
  const [error, setError] = useState('')

  const prepared = useMemo(() => (Object.keys(files).length ? prepareMigration(files) : null), [files])

  async function handleFiles(e) {
    const list = [...(e.target.files || [])]
    e.target.value = ''
    const next = {}
    const errors = []
    for (const file of list) {
      try {
        const parsed = readMigrationCsv(await file.text())
        next[parsed.kind] = parsed.records
      } catch (err) {
        errors.push(`${file.name}: ${err.message}`)
      }
    }
    setFiles(next)
    setReadErrors(errors)
    setImportResult(null)
    setError('')
  }

  async function handleImport() {
    setImporting(true)
    setError('')
    setImportResult(null)
    const done = []
    const warnings = []
    try {
      for (const kind of IMPORT_ORDER) {
        if (!files[kind]) continue
        // 検針データは不備・重複を除いたもの、ほかは CSV の行をそのまま送る（突き合わせはサーバー側）
        const records = kind === 'readings' ? prepared.readings : files[kind]
        let saved = 0
        for (let i = 0; i < records.length; i += CHUNK) {
          setProgress(`${LABELS[kind]}を取り込んでいます（${Math.min(i + CHUNK, records.length)} / ${records.length}件）`)
          const res = await importMeterRecords({
            kind,
            label: LABELS[kind],
            records: records.slice(i, i + CHUNK),
            last: i + CHUNK >= records.length,
            total: records.length,
          })
          saved += res.saved || 0
          for (const w of res.warnings || []) warnings.push(`${LABELS[kind]}: ${w}`)
        }
        done.push({ kind, saved })
      }
      setImportResult({ done, warnings })
      setFiles({})
      onImported()
    } catch (err) {
      setError(`${err.message}（ここまでに取り込んだ分はそのまま残ります。もう一度流しても重複しません）`)
      if (done.length) setImportResult({ done, warnings })
    } finally {
      setProgress('')
      setImporting(false)
    }
  }

  // ---------- 照合 ----------
  const [month, setMonth] = useState(() => counts?.latestReadingMonth || new Date().toISOString().slice(0, 7))
  const [xlsxFile, setXlsxFile] = useState(null)
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState(null)

  async function handleCheck() {
    setChecking(true)
    setError('')
    setCheck(null)
    try {
      const data = await fetchMeterOutputData(month)
      const output = buildMeterOutput({
        month,
        tenants: data.tenants,
        meters: data.meters,
        readings: data.readings,
        acUsage: data.acUsage,
        oaCoefficient: data.constants.oa_coefficient,
      })
      const readCount = data.readings.filter((r) => r.month === month).length
      let compared = null
      if (xlsxFile) {
        const rows = await readFirstSheetRows(await xlsxFile.arrayBuffer())
        compared = compareMeterOutput(output, rows)
      }
      setCheck({ month, output, readCount, compared, fileName: xlsxFile?.name || '' })
    } catch (err) {
      setError(err.message)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="meter-import">
      <section className="ui-card">
        <h3 className="ui-card-title">FileMaker の CSV を取り込む</h3>
        <p className="ui-note">
          FileMaker「検針記録」のテーブル（テナントマスタ・メータマスタ・検針データ・空調データ・空調機マスタ）を
          CSV で書き出したファイルを、まとめて選んでください。どれがどのテーブルかは中身で見分けます。
          何度取り込んでも重複せず、アプリで入力した月の検針値は上書きしません。
        </p>
        <p className="meter-import-counts">
          いま入っている件数: 検針値 {counts?.readings ?? 0}件
          {counts?.latestReadingMonth ? `（最新 ${counts.latestReadingMonth.replace('-', '年')}月度）` : ''}・空調データ{' '}
          {counts?.acUsage ?? 0}件
          {counts?.latestAcUsageMonth ? `（最新 ${counts.latestAcUsageMonth.replace('-', '年')}月度）` : ''}
        </p>
        <label className="btn-plain meter-file-btn">
          CSV を選ぶ
          <input type="file" accept=".csv,text/csv" multiple onChange={handleFiles} disabled={importing} hidden />
        </label>

        {readErrors.length > 0 && (
          <ul className="meter-import-warnings is-danger">
            {readErrors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}

        {prepared && (
          <>
            <table className="ui-table meter-import-table">
              <thead>
                <tr>
                  <th>テーブル</th>
                  <th className="is-numeric">件数</th>
                </tr>
              </thead>
              <tbody>
                {IMPORT_ORDER.map((kind) => (
                  <tr key={kind}>
                    <td>{LABELS[kind]}</td>
                    <td className="is-numeric">
                      {files[kind]
                        ? kind === 'readings'
                          ? `${prepared.readings.length}（CSV ${files[kind].length}行）`
                          : files[kind].length
                        : '選ばれていません'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {prepared.warnings.length > 0 && (
              <ul className="meter-import-warnings">
                {prepared.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <div className="meter-import-actions">
              <button type="button" className="btn-primary" onClick={handleImport} disabled={importing}>
                {importing ? '取り込み中…' : '取り込む'}
              </button>
              {progress && <span className="ui-note">{progress}</span>}
            </div>
          </>
        )}

        {importResult && (
          <div className="meter-import-result">
            <p>
              取り込みました:{' '}
              {importResult.done.map((d) => `${LABELS[d.kind]} ${d.saved}件`).join('・')}
            </p>
            {importResult.warnings.length > 0 && (
              <ul className="meter-import-warnings">
                {importResult.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="ui-card">
        <h3 className="ui-card-title">出力を FileMaker と突き合わせる</h3>
        <p className="ui-note">
          取り込んだデータで「検針データ_yyyy年mm月分」を組み立てます。FileMaker が出した同じ月の xlsx を選ぶと、
          全セルを比べて違うところを一覧にします（請求書Excelは列の位置で値を拾うため、全セル一致が条件です）。
        </p>
        <div className="meter-check-form">
          <label className="ui-field">
            <span>検針月度</span>
            <input type="month" className="ui-input" value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
          <label className="ui-field">
            <span>FileMaker の xlsx（任意）</span>
            <input
              type="file"
              accept=".xlsx"
              className="ui-input"
              onChange={(e) => setXlsxFile(e.target.files?.[0] || null)}
            />
          </label>
          <button type="button" className="btn-plain" onClick={handleCheck} disabled={checking || !month}>
            {checking ? '確認中…' : '組み立てる'}
          </button>
        </div>

        {check && (
          <div className="meter-check-result">
            <p>
              {check.month.replace('-', '年')}月度: 検針値 {check.readCount}件から {check.output.rows.length}行
              × {check.output.columns.length}列を組み立てました。
            </p>
            {check.compared &&
              (check.compared.problems.length === 0 ? (
                <p className="meter-check-ok">
                  {check.fileName} と {check.compared.cells}セルすべて一致しました。
                </p>
              ) : (
                <>
                  <p className="meter-check-ng">
                    {check.fileName} と {check.compared.problems.length}セル違います（{check.compared.cells}セル中）。
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
                        {check.compared.problems.slice(0, 100).map((p) => (
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
          </div>
        )}
      </section>

      {error && (
        <p className="dashboard-error dashboard-banner" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
