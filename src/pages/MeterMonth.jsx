import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import MeterPhoto from '../components/MeterPhoto'
import { IconCamera, IconChevronLeft, IconChevronRight, IconDownload } from '../components/Icons'
import useMeterPhotoPdfExport from '../hooks/useMeterPhotoPdfExport'
import { defaultMeterMonth, fetchMeterMonth, floorLabel, meterMonthLabel, saveMeterReading } from '../lib/meter'
import { buildMonthRows, formatRatio, formatTaken, formatValue, jstDateTime, monthProgress } from '../lib/meterMonth'
import { readingUsage, shiftMonth } from '../lib/meterOutput'
import { speakValue, speechSupported } from '../lib/speech'
import './Dashboard.css'
import './Meter.css'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// 検針（月度の作業。2026-10-20〜。docs/meter-plan.md 5章）。
//   /meter/:month          … 検針一覧（FileMaker の「一覧〜メータ値入力」）。写真・当月値・前月値・使用量・前月比
//   /meter/:month/:meterNo … 値の入力（FileMaker の「検針詳細」）。Enter で保存→読み上げ→次のメータへ
// 一覧と入力は同じ部品で描くので、メータを移っても月度のデータを読み直さない
export default function MeterMonth() {
  const params = useParams()
  const navigate = useNavigate()
  const month = MONTH_RE.test(params.month || '') ? params.month : defaultMeterMonth()
  const meterNo = params.meterNo ? decodeURIComponent(params.meterNo) : null
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [onlyAttention, setOnlyAttention] = useState(false)
  const pdf = useMeterPhotoPdfExport()

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
    load()
  }, [load])

  const rows = useMemo(() => (data && data.month === month ? buildMonthRows(data) : []), [data, month])
  const progress = useMemo(() => monthProgress(rows), [rows])
  const index = meterNo ? rows.findIndex((r) => r.meter.meter_no === meterNo) : -1

  function goMonth(delta) {
    navigate(`/meter/${shiftMonth(month, delta)}`)
  }

  function replaceReading(saved) {
    setData((d) => ({
      ...d,
      readings: [...d.readings.filter((r) => !(r.meter_id === saved.meter_id && r.month === saved.month)), saved],
    }))
  }

  const loading = !data && !error

  if (meterNo) {
    return (
      <div className="ui-page">
        <AppHeader />
        <div className="ui-container is-wide app-scroll">
          {error && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {error}
            </p>
          )}
          {loading ? (
            <p className="dashboard-loading">読み込み中…</p>
          ) : index < 0 ? (
            <p className="ui-empty">
              {meterMonthLabel(month)}の検針対象に「{meterNo}」はありません。{' '}
              <button type="button" className="btn-plain" onClick={() => navigate(`/meter/${month}`)}>
                一覧へ戻る
              </button>
            </p>
          ) : (
            <MeterEntry
              key={rows[index].meter.id}
              month={month}
              row={rows[index]}
              position={`${index + 1} / ${rows.length}`}
              prevRow={rows[index - 1] || null}
              nextRow={rows[index + 1] || null}
              onSaved={replaceReading}
              onGo={(row) => navigate(row ? `/meter/${month}/${encodeURIComponent(row.meter.meter_no)}` : `/meter/${month}`)}
            />
          )}
        </div>
      </div>
    )
  }

  const visible = onlyAttention ? rows.filter((r) => !r.photo || !r.entered || r.unusual || !r.verified) : rows
  const groups = []
  for (const r of visible) {
    const floor = r.tenant ? r.tenant.floor || '' : '—'
    const last = groups[groups.length - 1]
    if (last && last.floor === floor) last.rows.push(r)
    else groups.push({ floor, rows: [r] })
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-wide app-scroll">
        <FeatureHeader
          filters={
            <div className="inspection-month">
              <button type="button" className="icon-btn-nav" onClick={() => goMonth(-1)} aria-label="前の月度" title="前の月度">
                <IconChevronLeft size={28} />
              </button>
              <span className="inspection-month-label">{meterMonthLabel(month)}</span>
              <button type="button" className="icon-btn-nav" onClick={() => goMonth(1)} aria-label="次の月度" title="次の月度">
                <IconChevronRight size={28} />
              </button>
            </div>
          }
          actions={
            <>
              <button
                type="button"
                className="btn-plain"
                onClick={() => pdf.download(month, rows)}
                disabled={!rows.length || pdf.busy}
                title="写真一覧のPDF（1ページ8枚）"
              >
                <IconDownload size={20} />
                <span className="btn-plain-label">写真一覧PDF</span>
              </button>
              <button
                type="button"
                className="btn-plain"
                onClick={() => navigate(`/meter/${month}/photos`)}
                title="写真の取込"
              >
                <IconCamera size={20} />
                <span className="btn-plain-label">写真の取込</span>
              </button>
            </>
          }
        />

        {(error || pdf.error) && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error || pdf.error}
          </p>
        )}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : !data ? null : rows.length === 0 ? (
          <p className="ui-empty">
            検針するメータがありません。「検針マスタ」でメータを登録するか、FileMaker の CSV を取り込んでください。
          </p>
        ) : (
          <>
            <div className="meter-list-options">
              <span className="meter-progress">
                写真 <strong>{progress.photos}</strong>/{progress.total}・入力 <strong>{progress.entered}</strong>/
                {progress.total}・確認 <strong>{progress.verified}</strong>/{progress.total}
              </span>
              <label className="meter-check">
                <input type="checkbox" checked={onlyAttention} onChange={(e) => setOnlyAttention(e.target.checked)} />
                要確認だけ（写真なし・未入力・未確認・前月比が大きく違う）
              </label>
            </div>
            <div className="ui-table-wrap">
              <table className="ui-table meter-table meter-month-table">
                <thead>
                  <tr>
                    <th>写真</th>
                    <th>メータ</th>
                    <th>テナント・貸室</th>
                    <th className="is-numeric">当月値</th>
                    <th className="is-numeric">前月値</th>
                    <th className="is-numeric">使用量</th>
                    <th className="is-numeric">前月の使用量</th>
                    <th className="is-numeric">前月比</th>
                    <th>状態</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g, gi) => (
                    <Fragment key={`${g.floor}-${gi}`}>
                      <tr className="ui-table-group-head">
                        <td colSpan={9}>{g.floor === '—' ? 'テナントなし' : g.floor ? floorLabel(g.floor) : '階なし（共用エリアなど）'}</td>
                      </tr>
                      {g.rows.map((r) => (
                        <tr
                          key={r.meter.id}
                          className={`meter-row${r.unusual ? ' is-unusual' : ''}`}
                          onClick={() => navigate(`/meter/${month}/${encodeURIComponent(r.meter.meter_no)}`)}
                        >
                          <td className="meter-thumb-cell">
                            <MeterPhoto photo={r.photo} className="is-thumb" />
                          </td>
                          <td className="meter-no">
                            {r.meter.meter_no}
                            {r.meter.is_oa_meter && <span className="ui-badge is-action">外調機</span>}
                          </td>
                          <td>
                            {r.tenant?.short_name || r.tenant?.name || ''}
                            <div className="meter-sub">{r.meter.seal_label || r.meter.room_name || ''}</div>
                          </td>
                          <td className="is-numeric">
                            {formatValue(r.reading?.value)}
                            {r.meter.is_oa_meter && r.reading?.value2 != null && (
                              <div className="meter-sub">{formatValue(r.reading.value2)}</div>
                            )}
                          </td>
                          <td className="is-numeric">
                            {formatValue(r.usage.prev)}
                            {r.meter.is_oa_meter && <div className="meter-sub">{formatValue(r.usage.prev2)}</div>}
                          </td>
                          <td className="is-numeric">{r.entered ? formatValue(r.total) : ''}</td>
                          <td className="is-numeric">{formatValue(r.prevTotal)}</td>
                          <td className={`is-numeric${r.unusual ? ' meter-unusual' : ''}`}>{formatRatio(r.ratio)}</td>
                          <td>
                            {!r.photo && <span className="ui-badge is-danger">写真なし</span>}
                            {r.photoCount > 1 && <span className="ui-badge is-warn">写真{r.photoCount}枚</span>}
                            {!r.entered ? (
                              <span className="ui-badge">未入力</span>
                            ) : r.verified ? (
                              <span className="ui-badge is-current">確認済み</span>
                            ) : (
                              <span className="ui-badge is-warn">未確認</span>
                            )}
                          </td>
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
      {pdf.sheetsPortal}
      {pdf.previewModal}
      {pdf.busyOverlay}
    </div>
  )
}

const toText = (v) => (v == null ? '' : String(v))
const toNum = (v) => {
  const t = String(v ?? '').replace(/,/g, '').trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
}

// 値の入力（1メータ分）。左に写真、右に当月値など。Enter で保存→読み上げ→次のメータへ
function MeterEntry({ month, row, position, prevRow, nextRow, onSaved, onGo }) {
  const { meter, reading, prevReading } = row
  const [form, setForm] = useState(() => ({
    value: toText(reading?.value),
    value2: toText(reading?.value2),
    prev_override: toText(reading?.prev_override),
    diff_override: toText(reading?.diff_override),
    note: toText(reading?.note),
    verified: reading ? !!reading.verified_at || !!reading.legacy_id || reading.value == null : true,
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState(false)
  const valueRef = useRef(null)

  useEffect(() => {
    valueRef.current?.focus()
  }, [])

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  // 入力中の値で前月値・使用量を計算し直す（移行した月で値を変えたら FileMaker の保存値は使わない）
  const preview = useMemo(() => {
    const value = toNum(form.value)
    const value2 = toNum(form.value2)
    const unchanged = reading && reading.value === value && (reading.value2 ?? null) === value2
    const r = {
      value: Number.isNaN(value) ? null : value,
      value2: Number.isNaN(value2) ? null : value2,
      prev_override: toNum(form.prev_override),
      diff_override: toNum(form.diff_override),
      ...(unchanged
        ? {
            legacy_prev: reading.legacy_prev,
            legacy_prev2: reading.legacy_prev2,
            legacy_diff: reading.legacy_diff,
            legacy_diff2: reading.legacy_diff2,
          }
        : {}),
    }
    if (Number.isNaN(r.prev_override)) r.prev_override = null
    if (Number.isNaN(r.diff_override)) r.diff_override = null
    return readingUsage(r, prevReading, meter)
  }, [form, reading, prevReading, meter])

  const spokenValues = meter.is_oa_meter ? [form.value, form.value2] : [form.value]

  async function save({ next }) {
    setError('')
    const values = ['value', 'value2', 'prev_override', 'diff_override'].map((k) => toNum(form[k]))
    if (values.some((v) => Number.isNaN(v))) return setError('数字で入力してください')
    if (values[0] == null) return setError('当月値を入力してください')
    if (meter.digits && values[0] >= 10 ** meter.digits) {
      return setError(`このメータは${meter.digits}桁です。桁数を確かめてください`)
    }
    setSaving(true)
    try {
      const taken = jstDateTime(row.photo?.taken_at)
      const saved = await saveMeterReading({
        meter_id: meter.id,
        month,
        value: values[0],
        value2: meter.is_oa_meter ? values[1] : null,
        prev_override: values[2],
        diff_override: values[3],
        note: form.note,
        verified: form.verified,
        // 検針日付・時刻は写真の撮影日時（無ければサーバーが今の日時を入れる）。一度入った日付は変えない
        ...(reading?.read_on ? {} : taken ? { read_on: taken.date, read_time: taken.time } : {}),
      })
      onSaved(saved)
      speakValue(spokenValues)
      if (next) onGo(nextRow)
      else setSaving(false)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault()
      save({ next: true })
    }
  }

  const total = preview.diff + (meter.is_oa_meter ? preview.diff2 : 0)
  const ratio = row.prevTotal ? total / row.prevTotal : null

  return (
    <div className="meter-entry" onKeyDown={onKeyDown}>
      <FeatureHeader
        title={`${meter.meter_no}　${row.tenant?.short_name || row.tenant?.name || ''}`}
        leading={
          <button type="button" className="btn-plain" onClick={() => onGo(null)}>
            一覧へ
          </button>
        }
        actions={
          <>
            <span className="meter-position">{position}</span>
            <button type="button" className="icon-btn-nav" onClick={() => onGo(prevRow)} disabled={!prevRow} aria-label="前のメータ" title="前のメータ">
              <IconChevronLeft size={28} />
            </button>
            <button type="button" className="icon-btn-nav" onClick={() => onGo(nextRow)} disabled={!nextRow} aria-label="次のメータ" title="次のメータ">
              <IconChevronRight size={28} />
            </button>
          </>
        }
      />
      <div className="meter-entry-body">
        <div className="meter-entry-photo">
          <MeterPhoto photo={row.photo} alt={`メータ ${meter.meter_no} の写真`} onClick={() => setZoom(true)} />
          <p className="ui-note">
            {row.photo ? `撮影 ${formatTaken(row.photo.taken_at)}` : 'この月度の写真はまだありません'}
            {row.photoCount > 1 && `（${row.photoCount}枚のうち新しい方）`}
            {meter.seal_label ? `・シール「${meter.seal_label}」` : ''}
          </p>
        </div>
        <section className="ui-card meter-entry-form">
          <div className="meter-entry-values">
            <label className="ui-field">
              <span>{meter.is_oa_meter ? '当月値（1つめ）' : '当月値'}</span>
              <input
                ref={valueRef}
                className="ui-input meter-value-input"
                inputMode="decimal"
                autoComplete="off"
                value={form.value}
                onChange={set('value')}
              />
            </label>
            {meter.is_oa_meter && (
              <label className="ui-field">
                <span>当月値（2つめ）</span>
                <input className="ui-input meter-value-input" inputMode="decimal" autoComplete="off" value={form.value2} onChange={set('value2')} />
              </label>
            )}
          </div>
          <dl className="meter-entry-figures">
            <div>
              <dt>前月値</dt>
              <dd>
                {formatValue(preview.prev)}
                {meter.is_oa_meter && ` / ${formatValue(preview.prev2)}`}
              </dd>
            </div>
            <div>
              <dt>使用量</dt>
              <dd>{form.value === '' ? '' : formatValue(total)}</dd>
            </div>
            <div>
              <dt>前月の使用量</dt>
              <dd>{formatValue(row.prevTotal)}</dd>
            </div>
            <div>
              <dt>前月比</dt>
              <dd className={ratio != null && (ratio >= 1.5 || ratio <= 0.5) ? 'meter-unusual' : ''}>
                {form.value === '' ? '' : formatRatio(ratio)}
              </dd>
            </div>
          </dl>
          <div className="meter-form-grid">
            <label className="ui-field">
              <span>前月の修正</span>
              <input className="ui-input" inputMode="decimal" value={form.prev_override} onChange={set('prev_override')} placeholder="空なら前月の検針値" />
            </label>
            <label className="ui-field">
              <span>修正差分値</span>
              <input className="ui-input" inputMode="decimal" value={form.diff_override} onChange={set('diff_override')} placeholder="メータ交換のときなど" />
            </label>
          </div>
          <label className="ui-field">
            <span>備考</span>
            <textarea className="ui-textarea" rows={2} value={form.note} onChange={set('note')} />
          </label>
          <label className="switch-field">
            <input type="checkbox" checked={form.verified} onChange={(e) => setForm((f) => ({ ...f, verified: e.target.checked }))} />
            <span className="switch-track">
              <span className="switch-thumb" />
            </span>
            <span className="switch-label">写真と読み上げで値を確かめた</span>
          </label>
          {reading?.recorded_by && (
            <p className="ui-note">
              記録 {reading.recorded_by}
              {reading.verified_by ? `・確認 ${reading.verified_by}` : ''}
            </p>
          )}
          {error && <p className="ui-note is-danger">{error}</p>}
          <div className="meter-import-actions">
            {speechSupported() && (
              <button type="button" className="btn-plain" onClick={() => speakValue(spokenValues)} disabled={!form.value}>
                ♩ 読み上げ
              </button>
            )}
            <button type="button" className="btn-plain" onClick={() => save({ next: false })} disabled={saving}>
              保存する
            </button>
            <button type="button" className="btn-primary" onClick={() => save({ next: true })} disabled={saving}>
              {saving ? '保存中…' : nextRow ? '保存して次へ（Enter）' : '保存して一覧へ（Enter）'}
            </button>
          </div>
        </section>
      </div>
      {zoom && row.photo && (
        <div className="ui-overlay meter-zoom" role="dialog" aria-modal="true" onClick={() => setZoom(false)}>
          <MeterPhoto photo={row.photo} alt={`メータ ${meter.meter_no} の写真（拡大）`} className="is-zoom" />
        </div>
      )}
    </div>
  )
}
