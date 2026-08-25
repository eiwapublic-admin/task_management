import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import EquipmentInForm from '../components/EquipmentInForm'
import EquipmentOutForm from '../components/EquipmentOutForm'
import { IconHome } from '../components/Icons'
import { getCurrentUser } from '../lib/auth'
import { todayJST, jstDateOnly } from '../lib/reports'
import {
  EQUIPMENT_REASON_LABELS,
  fetchEquipmentItems,
  fetchEquipmentTransactions,
  deleteEquipmentTransaction,
  formatEquipmentDate,
} from '../lib/equipment'
import './Dashboard.css'
import './Equipment.css'

const PERIODS = [
  { key: '3m', label: '3ヶ月' },
  { key: '1y', label: '1年' },
  { key: 'all', label: '全期間' },
]

// 備品の履歴（5-2）。行タップで開く現行の明細部分に相当。
export default function EquipmentItemHistory() {
  const { itemNo } = useParams()
  const navigate = useNavigate()
  const user = getCurrentUser()
  const readOnly = user?.role === 'owner'
  // 備品出庫限定ロール（2026-08-25追加）。当日入力分の「出庫」の修正だけ許可する
  // （Equipment.jsx と同じ判定。詳細はそちらのコメント参照）
  const isEquipmentOutStaff = user?.role === 'equipment_out_staff'
  const canFullWrite = !readOnly && !isEquipmentOutStaff

  function canEditTxn(t) {
    if (canFullWrite) return true
    if (isEquipmentOutStaff) return t.kind === 'out' && jstDateOnly(t.occurred_at) === todayJST()
    return false
  }

  const [period, setPeriod] = useState('3m')
  const [item, setItem] = useState(null)
  const [transactions, setTransactions] = useState([])
  const [allItems, setAllItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null) // 編集対象の入出庫レコード

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [data, items] = await Promise.all([
        fetchEquipmentTransactions(itemNo, { period }),
        fetchEquipmentItems({ includeDisabled: true }),
      ])
      setItem(data.item)
      setTransactions(data.transactions || [])
      setAllItems(items)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [itemNo, period])

  useEffect(() => {
    load()
  }, [load])

  function handleSaved() {
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
        <FeatureHeader
          title={item?.name || '備品の履歴'}
          leading={
            <button
              type="button"
              className="icon-btn-home"
              onClick={() => navigate('/equipment')}
              aria-label="在庫一覧に戻る"
              title="在庫一覧に戻る"
            >
              <IconHome size={32} />
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
        ) : item ? (
          <>
            <div className="equipment-history-head">
              <span className="equipment-history-stat">
                製品番号: <strong>{item.product_code || '—'}</strong>
              </span>
              <span className="equipment-history-stat">
                現在庫: <strong>{item.track_stock ? item.stock_qty : '—'}</strong>
              </span>
              <span className="equipment-history-stat">
                年計: 入庫 <strong>{item.year_in_qty}</strong> / 出庫 <strong>{item.year_out_qty}</strong>
              </span>
            </div>

            <nav className="ui-segmented" aria-label="表示期間">
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

            {transactions.length === 0 ? (
              <p className="ui-empty">この期間の入出庫記録はありません。</p>
            ) : (
              <div className="ui-table-wrap">
                <table className="ui-table equipment-txn-table">
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
                    {transactions.map((t) => {
                      const editable = canEditTxn(t)
                      return (
                      <tr
                        key={t.id}
                        className={editable ? 'equipment-history-row' : ''}
                        onClick={editable ? () => setEditing(t) : undefined}
                      >
                        <td>{formatEquipmentDate(t.occurred_at)}</td>
                        <td>{EQUIPMENT_REASON_LABELS[t.reason] || t.reason}</td>
                        <td className="is-numeric equipment-history-in">{t.kind === 'in' ? t.quantity : ''}</td>
                        <td className="is-numeric equipment-history-out">{t.kind === 'out' ? t.quantity : ''}</td>
                        <td className="is-numeric">{t.balance}</td>
                        <td>{t.tenant_short_name || t.location || ''}</td>
                        <td>{t.staff_name || ''}</td>
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <p className="ui-empty">備品が見つかりません。</p>
        )}
      </div>

      {editing &&
        canEditTxn(editing) &&
        (editing.kind === 'in' ? (
          <EquipmentInForm
            items={allItems}
            existing={editing}
            onClose={() => setEditing(null)}
            onSaved={handleSaved}
            onDelete={handleDelete}
          />
        ) : (
          <EquipmentOutForm
            items={allItems}
            existing={editing}
            dateLocked={isEquipmentOutStaff}
            canDelete={!isEquipmentOutStaff}
            onClose={() => setEditing(null)}
            onSaved={handleSaved}
            onDelete={handleDelete}
          />
        ))}
    </div>
  )
}
