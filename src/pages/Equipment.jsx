import { useCallback, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import EquipmentInForm from '../components/EquipmentInForm'
import EquipmentOutForm from '../components/EquipmentOutForm'
import { getCurrentUser } from '../lib/auth'
import {
  EQUIPMENT_REASON_LABELS,
  deleteEquipmentTransaction,
  fetchEquipmentItems,
  fetchEquipmentTransactionsAll,
} from '../lib/equipment'
import './Dashboard.css'
import './Equipment.css'

const PERIODS = [
  { key: '3m', label: '3ヶ月' },
  { key: '1y', label: '1年' },
  { key: 'all', label: '全期間' },
]

function formatDate(value) {
  return new Date(value).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// 在庫一覧（備品セクションのホーム画面）。
// 各備品の入出庫明細は行をタップしなくてもその場に展開表示する（2026-08-12〜）。
// 表示期間（3ヶ月/1年/全期間）はこの画面の上部でまとめて切り替える
// （docs/equipment-plan.md 5-1・5-2 を統合。旧・備品履歴画面は EquipmentItemHistory.jsx に残るが、
// この画面からのリンクは廃止した）。
export default function Equipment() {
  const user = getCurrentUser()
  const readOnly = user?.role === 'owner'

  const [period, setPeriod] = useState('3m')
  const [items, setItems] = useState([])
  const [transactionsByItem, setTransactionsByItem] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showDisabled, setShowDisabled] = useState(false)
  const [mode, setMode] = useState(null) // null | 'in' | 'out'
  const [editing, setEditing] = useState(null) // 編集対象の入出庫レコード

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [itemsData, txnData] = await Promise.all([
        fetchEquipmentItems({ includeDisabled: showDisabled }),
        fetchEquipmentTransactionsAll({ period }),
      ])
      setItems(itemsData)
      setTransactionsByItem(txnData)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [showDisabled, period])

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

  function handleModalSaved() {
    setMode(null)
    setEditing(null)
    load()
  }

  async function handleDelete(id) {
    setEditing(null)
    try {
      await deleteEquipmentTransaction(id)
      load()
    } catch (err) {
      setError(err.message)
    }
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

        <nav className="ui-segmented" aria-label="明細の表示期間">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`ui-segmented-btn${period === p.key ? ' is-active' : ''}`}
              aria-current={period === p.key ? 'page' : undefined}
              onClick={() => setPeriod(p.key)}
            >
              {p.label}
            </button>
          ))}
        </nav>

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
                    const txns = transactionsByItem[item.id] || []
                    return (
                      <li key={item.id} className="equipment-stock-item">
                        <div className="equipment-stock-row is-static">
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
                        </div>
                        <div className="equipment-stock-detail">
                          {txns.length === 0 ? (
                            <p className="ui-empty">この期間の入出庫記録はありません。</p>
                          ) : (
                            <div className="ui-table-wrap">
                              <table className="ui-table">
                                <thead>
                                  <tr>
                                    <th>日付</th>
                                    <th>理由</th>
                                    <th className="is-numeric">入庫</th>
                                    <th className="is-numeric">出庫</th>
                                    <th className="is-numeric">残</th>
                                    <th>設置先</th>
                                    <th>担当</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {txns.map((t) => (
                                    <tr
                                      key={t.id}
                                      className={readOnly ? '' : 'equipment-history-row'}
                                      onClick={readOnly ? undefined : () => setEditing(t)}
                                    >
                                      <td>{formatDate(t.occurred_at)}</td>
                                      <td>{EQUIPMENT_REASON_LABELS[t.reason] || t.reason}</td>
                                      <td className="is-numeric equipment-history-in">
                                        {t.kind === 'in' ? t.quantity : ''}
                                      </td>
                                      <td className="is-numeric equipment-history-out">
                                        {t.kind === 'out' ? t.quantity : ''}
                                      </td>
                                      <td className="is-numeric">{t.balance}</td>
                                      <td>{t.tenant_short_name || t.location || ''}</td>
                                      <td>{t.staff_name || ''}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
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

      {mode === 'in' && <EquipmentInForm items={items} onClose={() => setMode(null)} onSaved={handleModalSaved} />}
      {mode === 'out' && <EquipmentOutForm items={items} onClose={() => setMode(null)} onSaved={handleModalSaved} />}

      {editing &&
        !readOnly &&
        (editing.kind === 'in' ? (
          <EquipmentInForm
            items={items}
            existing={editing}
            onClose={() => setEditing(null)}
            onSaved={handleModalSaved}
            onDelete={handleDelete}
          />
        ) : (
          <EquipmentOutForm
            items={items}
            existing={editing}
            onClose={() => setEditing(null)}
            onSaved={handleModalSaved}
            onDelete={handleDelete}
          />
        ))}
    </div>
  )
}
