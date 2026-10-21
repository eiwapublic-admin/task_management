import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import MeterForm from '../components/MeterForm'
import MeterTenantForm from '../components/MeterTenantForm'
import TenantTable from '../components/TenantTable'
import MeterImportPanel from '../components/MeterImportPanel'
import MeterHistoryList from '../components/MeterHistoryList'
import { fetchMeterMasters, floorLabel, saveMeterConstants, updateMeterAcUnit } from '../lib/meter'
import './Dashboard.css'
import './Meter.css'

const TABS = [
  { key: 'tenants', label: 'テナント' },
  { key: 'meters', label: 'メータ' },
  { key: 'ac', label: '空調機' },
  { key: 'constants', label: '定数' },
  { key: 'history', label: '変更履歴' },
  { key: 'import', label: '取込・照合' },
]

// 階の並び（空欄＝共用エリアが先頭、B1F、1F〜7F）
const FLOOR_RANK = new Map(['', 'B', '1', '2', '3', '4', '5', '6', '7'].map((f, i) => [f, i]))
const floorRank = (f) => FLOOR_RANK.get(f || '') ?? 99

function todayIso() {
  const d = new Date(Date.now() + 9 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

function formatDate(iso) {
  return iso ? iso.replaceAll('-', '/') : ''
}

// 検針マスタ（FileMaker「検針記録」のマスター画面の移植。2026-10-20〜。docs/meter-plan.md 5章）。
// テナント（備品と共有）・メータ・空調機の割当て・定数を見て直す。FileMaker の CSV の取込と、
// 出力を FileMaker と突き合わせる照合もここに置く（Phase 1）。社員だけが使う
export default function MeterMasters() {
  const [tab, setTab] = useState('tenants')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editingTenant, setEditingTenant] = useState(null)
  const [editingMeter, setEditingMeter] = useState(null)
  const [showMovedOut, setShowMovedOut] = useState(false)
  const [showRemoved, setShowRemoved] = useState(false)

  const load = useCallback(async () => {
    setError('')
    try {
      setData(await fetchMeterMasters())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const tenants = useMemo(() => data?.tenants || [], [data])
  const meters = useMemo(() => data?.meters || [], [data])
  const tenantById = useMemo(() => new Map(tenants.map((t) => [t.id, t])), [tenants])
  const meterById = useMemo(() => new Map(meters.map((m) => [m.id, m])), [meters])
  const meterCountByTenant = useMemo(() => {
    const map = new Map()
    for (const m of meters) if (m.tenant_id && !m.removed) map.set(m.tenant_id, (map.get(m.tenant_id) || 0) + 1)
    return map
  }, [meters])

  // メータはテナントごと（テナントの階→請求先コード→連番）、テナントの無いメータは最後
  const meterGroups = useMemo(() => {
    const list = meters.filter((m) => showRemoved || !m.removed)
    const map = new Map()
    for (const m of list) {
      const key = m.tenant_id || ''
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(m)
    }
    return [...map.entries()]
      .map(([tenantId, rows]) => ({
        tenant: tenantId ? tenantById.get(tenantId) : null,
        rows: rows.sort((a, b) => (a.seq ?? 99) - (b.seq ?? 99) || a.meter_no.localeCompare(b.meter_no)),
      }))
      .sort((a, b) => {
        if (!a.tenant || !b.tenant) return a.tenant ? -1 : b.tenant ? 1 : 0
        return (
          floorRank(a.tenant.floor) - floorRank(b.tenant.floor) || (a.tenant.billing_code || '').localeCompare(b.tenant.billing_code || '')
        )
      })
  }, [meters, showRemoved, tenantById])

  const expiredCount = useMemo(() => {
    const today = todayIso()
    return meters.filter((m) => !m.removed && m.expires_on && m.expires_on < today).length
  }, [meters])

  function replaceTenant(saved) {
    setData((d) => {
      const exists = d.tenants.some((t) => t.id === saved.id)
      return {
        ...d,
        tenants: exists ? d.tenants.map((t) => (t.id === saved.id ? saved : t)) : [...d.tenants, saved],
      }
    })
    setEditingTenant(null)
  }

  // メータを保存すると、ほかのメータの按分比率と按分対象の面積（定数）も変わるので読み直す
  function replaceMeter() {
    setEditingMeter(null)
    load()
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-wide app-scroll">
        <FeatureHeader
          filters={
            <div className="ui-segmented" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={`ui-segmented-btn${tab === t.key ? ' is-active' : ''}`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          }
          actions={
            tab === 'tenants' ? (
              <button
                type="button"
                className="icon-btn-add"
                onClick={() => setEditingTenant('new')}
                aria-label="テナントを追加"
                title="テナントを追加"
              >
                ＋
              </button>
            ) : tab === 'meters' ? (
              <button
                type="button"
                className="icon-btn-add"
                onClick={() => setEditingMeter('new')}
                aria-label="メータを追加"
                title="メータを追加"
              >
                ＋
              </button>
            ) : null
          }
        />

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : !data ? null : tab === 'tenants' ? (
          <>
            <div className="meter-list-options">
              <label className="meter-check">
                <input type="checkbox" checked={showMovedOut} onChange={(e) => setShowMovedOut(e.target.checked)} />
                退去済みを含む
              </label>
            </div>
            <TenantTable tenants={tenants} includeMovedOut={showMovedOut} meterCount={meterCountByTenant} onEdit={setEditingTenant} />
          </>
        ) : tab === 'meters' ? (
          <>
            <div className="meter-list-options">
              <label className="meter-check">
                <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
                撤去済みも表示
              </label>
              {expiredCount > 0 && <span className="ui-badge is-danger">有効期限切れ {expiredCount}台</span>}
            </div>
            {meters.length === 0 ? (
              <p className="ui-empty">メータがまだありません。「取込・照合」から FileMaker の CSV を取り込んでください。</p>
            ) : (
              <div className="ui-table-wrap meter-sticky-wrap">
                <table className="ui-table meter-table">
                  <thead>
                    <tr>
                      <th>メータ番号</th>
                      <th>部屋番号</th>
                      <th>連番</th>
                      <th>階</th>
                      <th>請求明細補足</th>
                      <th>検針内容</th>
                      <th>有効期限</th>
                      <th>計測対象</th>
                      <th className="is-numeric">坪</th>
                      <th className="is-numeric">㎡</th>
                      <th className="is-numeric">按分比率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {meterGroups.map((g) => (
                      <Fragment key={g.tenant?.id || 'none'}>
                        <tr className="ui-table-group-head">
                          <td colSpan={11}>
                            {g.tenant
                              ? `${g.tenant.billing_code || '—'} ${g.tenant.short_name || g.tenant.name}${g.tenant.moved_out ? '（退去済み）' : ''}`
                              : 'テナントなし（空室・未割当）'}
                          </td>
                        </tr>
                        {g.rows.map((m) => {
                          const expired = !m.removed && m.expires_on && m.expires_on < todayIso()
                          return (
                            <tr key={m.id} className={`meter-row${m.removed ? ' is-removed' : ''}`} onClick={() => setEditingMeter(m)}>
                              <td className="meter-no">
                                {m.meter_no}
                                {m.is_oa_meter && <span className="ui-badge is-action">外調機</span>}
                                {m.removed && <span className="ui-badge">撤去済み</span>}
                              </td>
                              <td>{m.room_no}</td>
                              <td>{m.seq ?? ''}</td>
                              <td>{m.floor ? floorLabel(m.floor) : ''}</td>
                              <td>{m.detail_note}</td>
                              <td>{m.kind || '—'}</td>
                              <td className={expired ? 'meter-expired' : ''}>{formatDate(m.expires_on)}</td>
                              <td>{m.measured ? '○' : ''}</td>
                              <td className="is-numeric">{m.area_tsubo ?? ''}</td>
                              <td className="is-numeric">{m.area_m2 ?? ''}</td>
                              <td className="is-numeric">{m.oa_share ? (m.oa_ratio ?? '') : ''}</td>
                            </tr>
                          )
                        })}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : tab === 'ac' ? (
          <AcUnitsTab units={data.acUnits} meters={meters} meterById={meterById} tenantById={tenantById} onChanged={load} />
        ) : tab === 'constants' ? (
          <ConstantsTab constants={data.constants} onSaved={(constants) => setData((d) => ({ ...d, constants }))} />
        ) : tab === 'history' ? (
          <MeterHistoryList tenants={tenants} meters={meters} onReverted={load} />
        ) : (
          <MeterImportPanel counts={data.counts} onImported={load} />
        )}
      </div>

      {editingTenant && (
        <MeterTenantForm
          tenant={editingTenant === 'new' ? null : editingTenant}
          onClose={() => setEditingTenant(null)}
          onSaved={replaceTenant}
          onReverted={() => {
            setEditingTenant(null)
            load()
          }}
        />
      )}
      {editingMeter && (
        <MeterForm
          meter={editingMeter === 'new' ? null : editingMeter}
          tenants={tenants}
          meters={meters}
          onClose={() => setEditingMeter(null)}
          onSaved={replaceMeter}
          onReverted={() => {
            setEditingMeter(null)
            load()
          }}
        />
      )}
    </div>
  )
}

// 空調機（室内機）ごとに、電力を足し込むメータを選ぶ。選んだらその場で保存する
function AcUnitsTab({ units, meters, meterById, tenantById, onChanged }) {
  const [savingUnit, setSavingUnit] = useState(null)
  const [error, setError] = useState('')
  const options = useMemo(
    () => meters.filter((m) => !m.removed).sort((a, b) => a.meter_no.localeCompare(b.meter_no, 'ja', { numeric: true })),
    [meters],
  )

  async function change(unit, meterId) {
    setSavingUnit(unit.unit_no)
    setError('')
    try {
      await updateMeterAcUnit(unit.unit_no, meterId)
      await onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingUnit(null)
    }
  }

  if (units.length === 0) {
    return <p className="ui-empty">空調機がまだありません。「取込・照合」から FileMaker の CSV を取り込んでください。</p>
  }
  return (
    <>
      <p className="ui-note">
        室内機の昼間の電力量を、ここで選んだメータに足し込みます（出力の「空調電力使用量_計」）。
        直した割当ては、次に取り込む空調データから効きます（取込済みの月は取り込んだ時点の割当てのまま）。
      </p>
      {error && <p className="ui-note is-danger">{error}</p>}
      <div className="ui-table-wrap meter-sticky-wrap">
        <table className="ui-table meter-table">
          <thead>
            <tr>
              <th className="is-numeric">空調機番号</th>
              <th>アドレス</th>
              <th>割当てメータ</th>
              <th>テナント</th>
            </tr>
          </thead>
          <tbody>
            {units.map((u) => {
              const meter = u.meter_id ? meterById.get(u.meter_id) : null
              const tenant = meter?.tenant_id ? tenantById.get(meter.tenant_id) : null
              return (
                <tr key={u.unit_no}>
                  <td className="is-numeric">{u.unit_no}</td>
                  <td>{u.address}</td>
                  <td>
                    <select
                      className="ui-select is-compact"
                      value={u.meter_id || ''}
                      disabled={savingUnit === u.unit_no}
                      onChange={(e) => change(u, e.target.value)}
                    >
                      <option value="">（割当てなし）</option>
                      {options.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.meter_no}
                          {m.detail_note ? `　${m.detail_note}` : ''}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{tenant ? tenant.short_name || tenant.name : ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

const CONSTANT_FIELDS = [
  {
    key: 'oa_coefficient',
    label: '外調データ係数',
    note: '外調機電気量_請求用 ＝ 外調機の当月の電力量 × 係数 × 按分比率',
  },
  { key: 'total_area', label: '総面積（㎡）', note: '' },
  {
    key: 'oa_target_area',
    label: '総面積_外調機按分対象（㎡）',
    note: '按分比率の分母。メータマスタで「外調機電気量を按分する」にしているメータの部屋面積の合計を自動で計算します（入力しません）',
    auto: true,
  },
]

function ConstantsTab({ constants, onSaved }) {
  const [form, setForm] = useState(() => Object.fromEntries(CONSTANT_FIELDS.map((f) => [f.key, String(constants?.[f.key] ?? '')])))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  async function handleSave() {
    setSaving(true)
    setMessage('')
    try {
      const saved = await saveMeterConstants(
        Object.fromEntries(Object.entries(form).filter(([k]) => !CONSTANT_FIELDS.find((f) => f.key === k)?.auto)),
      )
      onSaved(saved)
      setMessage('保存しました')
    } catch (err) {
      setMessage(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="ui-card meter-constants">
      {CONSTANT_FIELDS.map((f) => (
        <label key={f.key} className="ui-field">
          <span>{f.label}</span>
          <input
            className="ui-input"
            inputMode="decimal"
            value={f.auto ? String(constants?.[f.key] ?? '') : form[f.key]}
            onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value }))}
            readOnly={f.auto}
            disabled={f.auto}
          />
          {f.note && <small className="ui-note">{f.note}</small>}
        </label>
      ))}
      <p className="ui-note">提出メールの宛先・件名・本文は、出力を作る Phase 3 でここに足します。</p>
      <div className="meter-import-actions">
        <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '保存する'}
        </button>
        {message && <span className="ui-note">{message}</span>}
      </div>
    </section>
  )
}
