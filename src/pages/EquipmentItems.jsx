import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import EquipmentItemForm from '../components/EquipmentItemForm'
import EquipmentCategoryForm from '../components/EquipmentCategoryForm'
import { fetchEquipmentItems, fetchEquipmentCategories } from '../lib/equipment'
import './Dashboard.css'
import './Equipment.css'

// 備品マスタ（5-6）。カテゴリマスタはこの画面のツールバーから開くモーダルで扱う。
export default function EquipmentItems() {
  const [items, setItems] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editingItem, setEditingItem] = useState(null) // null | 'new' | item
  const [editingCategories, setEditingCategories] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [itemsData, categoriesData] = await Promise.all([
        fetchEquipmentItems({ includeDisabled: true }),
        fetchEquipmentCategories(),
      ])
      setItems(itemsData)
      setCategories(categoriesData)
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
    for (const item of items) {
      const key = item.category_code || ''
      if (!map.has(key)) map.set(key, { name: item.category_name || '（カテゴリ未設定）', rows: [] })
      map.get(key).rows.push(item)
    }
    return [...map.values()]
  }, [items])

  function handleItemSaved() {
    setEditingItem(null)
    load()
  }

  function handleItemDeleted() {
    setEditingItem(null)
    load()
  }

  function handleCategoriesSaved() {
    setEditingCategories(false)
    load()
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-narrow app-scroll">
        <FeatureHeader
          actions={
            <>
              <button type="button" className="btn-plain" onClick={() => setEditingCategories(true)}>
                カテゴリ
              </button>
              <button type="button" className="btn-primary" onClick={() => setEditingItem('new')}>
                備品を追加
              </button>
            </>
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
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>備品ID</th>
                  <th>備品名</th>
                  <th>製品番号</th>
                  <th className="is-numeric">警告数量</th>
                  <th className="is-numeric">在庫数</th>
                  <th>状態</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.name}>
                    <tr>
                      <td colSpan={6} className="ui-table-group-head">
                        {g.name}
                      </td>
                    </tr>
                    {g.rows.map((item) => (
                      <tr key={item.id} className="equipment-history-row" onClick={() => setEditingItem(item)}>
                        <td>{item.item_no}</td>
                        <td>{item.name}</td>
                        <td>{item.product_code || ''}</td>
                        <td className="is-numeric">{item.warn_qty ?? ''}</td>
                        <td className="is-numeric">{item.track_stock ? item.stock_qty : '—'}</td>
                        <td>{item.disabled && <span className="ui-badge">無効</span>}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editingItem && (
        <EquipmentItemForm
          key={editingItem === 'new' ? 'new' : editingItem.id}
          existing={editingItem === 'new' ? null : editingItem}
          categories={categories}
          onClose={() => setEditingItem(null)}
          onSaved={handleItemSaved}
          onDeleted={handleItemDeleted}
        />
      )}

      {editingCategories && (
        <EquipmentCategoryForm
          categories={categories}
          onClose={() => setEditingCategories(false)}
          onSaved={handleCategoriesSaved}
        />
      )}
    </div>
  )
}
