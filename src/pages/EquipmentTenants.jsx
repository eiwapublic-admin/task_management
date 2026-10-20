import { useCallback, useEffect, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import MeterTenantForm from '../components/MeterTenantForm'
import TenantTable from '../components/TenantTable'
import { getCurrentUser, isLimitedRole } from '../lib/auth'
import { fetchEquipmentTenants } from '../lib/equipment'
import { fetchMeterTenants } from '../lib/meter'
import './Dashboard.css'
import './Meter.css'

// テナントマスタ（2026-08-26〜。2026-10-20 から社員は追加・修正もできる）。
// 備品と検針で1つの表（equipment_tenants）を共有している。検針マスタのテナントタブと同じ一覧・同じ入力画面。
// 退去は退去日で表し、退去済みは各階の末尾に灰色で出す（既定では隠す）。
// 小泉産業様（owner）などは参照だけ（基本情報 profile を含まない備品の API で読む）
export default function EquipmentTenants() {
  const canEdit = !isLimitedRole(getCurrentUser())
  const [tenants, setTenants] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [includeMovedOut, setIncludeMovedOut] = useState(false)
  const [editing, setEditing] = useState(null) // テナント or 'new'

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setTenants(canEdit ? await fetchMeterTenants() : await fetchEquipmentTenants({ includeMovedOut: true }))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [canEdit])

  useEffect(() => {
    load()
  }, [load])

  function replaceTenant(saved) {
    setTenants((list) => (list.some((t) => t.id === saved.id) ? list.map((t) => (t.id === saved.id ? saved : t)) : [...list, saved]))
    setEditing(null)
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-wide app-scroll">
        <FeatureHeader
          filters={
            <label className="meter-check">
              <input type="checkbox" checked={includeMovedOut} onChange={(e) => setIncludeMovedOut(e.target.checked)} />
              退去済みを含む
            </label>
          }
          actions={
            canEdit ? (
              <button
                type="button"
                className="icon-btn-add"
                onClick={() => setEditing('new')}
                aria-label="テナントを追加"
                title="テナントを追加"
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
        ) : (
          <TenantTable tenants={tenants} includeMovedOut={includeMovedOut} onEdit={canEdit ? setEditing : null} />
        )}
      </div>

      {editing && (
        <MeterTenantForm tenant={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={replaceTenant} />
      )}
    </div>
  )
}
