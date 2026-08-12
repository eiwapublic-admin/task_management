import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import EquipmentInForm from '../components/EquipmentInForm'
import EquipmentOutForm from '../components/EquipmentOutForm'
import { getCurrentUser } from '../lib/auth'
import { fetchEquipmentItems } from '../lib/equipment'
import './Dashboard.css'
import './Equipment.css'

// 在庫一覧（Phase 1。2026-08-12〜）。備品セクションのホーム画面。
// 現行 FileMaker の「入出庫記録」に相当するが、密な1画面にはせず「在庫を見る」だけに絞る
// （履歴は行タップで /equipment/items/:itemNo へ。docs/equipment-plan.md 5-1）。
export default function Equipment() {
  const navigate = useNavigate()
  const user = getCurrentUser()
  const readOnly = user?.role === 'owner'

  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showDisabled, setShowDisabled] = useState(false)
  const [mode, setMode] = useState(null) // null | 'in' | 'out'

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setItems(await fetchEquipmentItems({ includeDisabled: showDisabled }))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [showDisabled])

  useEffect(() => {
    load()
  }, [load])

  const groups = useMemo(() => {
    const map = new Map()
    for (const item of items) {
      const key = item.category_code || ''
      if (!map.has(key)) map.set(key, { name: item.category_name || '（カテゴリ未設定）', rows: [] })
      map.get(key).rows.push(item)
    }
    return [...map.values()]
  }, [items])

  function handleSaved() {
    setMode(null)
    load()
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-narrow">
        <div className="ui-toolbar">
          <h2 className="ui-page-title">備品</h2>
          {!readOnly && (
            <div className="ui-toolbar-actions">
              <button type="button" className="btn-plain" onClick={() => setMode('in')}>
                入庫
              </button>
              <button type="button" className="btn-primary" onClick={() => setMode('out')}>
                出庫
              </button>
            </div>
          )}
        </div>

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : groups.length === 0 ? (
          <p className="ui-empty">備品が登録されていません。</p>
        ) : (
          <div className="equipment-stock-list">
            {groups.map((g) => (
              <section className="equipment-stock-group" key={g.name}>
                <h3 className="equipment-stock-group-head">{g.name}</h3>
                <ul className="equipment-stock-rows">
                  {g.rows.map((item) => {
                    const warn =
                      item.track_stock &&
                      item.warn_qty != null &&
                      item.stock_qty != null &&
                      item.stock_qty <= item.warn_qty
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="equipment-stock-row"
                          onClick={() => navigate(`/equipment/items/${item.item_no}`)}
                        >
                          <span className="equipment-stock-name">
                            {item.name}
                            {item.disabled && <span className="ui-badge">無効</span>}
                          </span>
                          <span className="equipment-stock-code">{item.product_code || ''}</span>
                          {item.track_stock ? (
                            <span className={`equipment-stock-qty${warn ? ' is-danger' : ''}`}>
                              {item.stock_qty}
                            </span>
                          ) : (
                            <span className="equipment-stock-qty is-muted">—</span>
                          )}
                          {warn && <span className="ui-badge is-danger">発注依頼してください</span>}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        <label className="equipment-toggle-disabled">
          <input type="checkbox" checked={showDisabled} onChange={(e) => setShowDisabled(e.target.checked)} />
          無効な備品も表示する
        </label>
      </div>

      {mode === 'in' && <EquipmentInForm items={items} onClose={() => setMode(null)} onSaved={handleSaved} />}
      {mode === 'out' && <EquipmentOutForm items={items} onClose={() => setMode(null)} onSaved={handleSaved} />}
    </div>
  )
}
