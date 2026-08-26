import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import { EQUIPMENT_FLOOR_OPTIONS, fetchEquipmentTenants } from '../lib/equipment'
import './Dashboard.css'
import './Equipment.css'

// 階の並び順（B, 1〜7）。この一覧に無い階（空欄＝共用部等）は最後に回す
const FLOOR_ORDER = new Map(EQUIPMENT_FLOOR_OPTIONS.map((f, i) => [f, i]))

function floorGroupLabel(floor) {
  return floor ? `${floor}F` : '（階なし・共用部）'
}

// テナントマスタ（参照専用。2026-08-26）。テナント情報はFileMakerを正として
// 同期される（docs/equipment-plan.md 2-6・7-1）ため、この画面はあくまで
// 一覧の紹介・確認用で、作成・編集・削除は持たせない。
export default function EquipmentTenants() {
  const [tenants, setTenants] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setTenants(await fetchEquipmentTenants({ includeMovedOut: true }))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const groups = useMemo(() => {
    const map = new Map()
    for (const t of tenants) {
      const key = t.floor || ''
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(t)
    }
    return [...map.entries()]
      .sort(([a], [b]) => (FLOOR_ORDER.get(a) ?? 99) - (FLOOR_ORDER.get(b) ?? 99))
      .map(([floor, rows]) => ({
        floor,
        rows: rows.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja')),
      }))
  }, [tenants])

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-narrow app-scroll">
        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : tenants.length === 0 ? (
          <p className="ui-empty">テナントが登録されていません。</p>
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table equipment-tenant-table">
              <thead>
                <tr>
                  <th>請求先コード</th>
                  <th>テナント名</th>
                  <th>略称</th>
                  <th>状態</th>
                  <th>備考</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.floor}>
                    <tr>
                      <td colSpan={5} className="equipment-tenant-floor-head">
                        {floorGroupLabel(g.floor)}
                      </td>
                    </tr>
                    {g.rows.map((t) => (
                      <tr key={t.id}>
                        <td>{t.billing_code || ''}</td>
                        <td className="equipment-tenant-name-cell">{t.name}</td>
                        <td>{t.short_name || ''}</td>
                        <td>{t.moved_out && <span className="ui-badge is-danger">退去済み</span>}</td>
                        <td>{t.note || ''}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
