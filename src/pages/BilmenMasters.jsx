import { useCallback, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import BilmenMasterForm from '../components/BilmenMasterForm'
import { getCurrentUser, isLimitedRole } from '../lib/auth'
import { fetchBilmenMasters, renumberBilmenMasters, formatMonths } from '../lib/bilmen'
import './Dashboard.css'
import './Bilmen.css'

// 作業マスタ（docs/bilmen-plan.md 2-6・5-5）。現行の列構成を踏襲し、初版は表示順の単純並び。
// owner（小泉産業様）は閲覧のみ（10章）。書き込みの正はサーバー側で拒否される。
export default function BilmenMasters() {
  const readOnly = isLimitedRole(getCurrentUser())
  const [masters, setMasters] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [renumbering, setRenumbering] = useState(false)
  const [editing, setEditing] = useState(null) // null | 'new' | master

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setMasters(await fetchBilmenMasters({ includeDisabled: true }))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 担当会社名の入力候補（既存の登録値から。備品・連絡帳と同じ考え方で選択式には強制しない）
  const vendorOptions = useMemo(() => {
    const seen = new Set()
    for (const m of masters) if (m.vendor_name) seen.add(m.vendor_name)
    return [...seen]
  }, [masters])

  async function handleRenumber() {
    setRenumbering(true)
    setError('')
    setInfo('')
    try {
      const result = await renumberBilmenMasters()
      setInfo(
        result.updated > 0
          ? `表示順を10刻みに振り直しました（${result.updated}件を変更）。`
          : '表示順は既に10刻みで並んでいます。',
      )
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setRenumbering(false)
    }
  }

  function handleSaved() {
    setEditing(null)
    load()
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-narrow app-scroll">
        <FeatureHeader
          actions={
            readOnly ? null : (
              <>
                <button type="button" className="btn-plain" onClick={handleRenumber} disabled={renumbering}>
                  {renumbering ? '再採番中…' : '表示順を再採番'}
                </button>
                <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
                  作業を追加
                </button>
              </>
            )
          }
        />

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}
        {info && <p className="dashboard-banner">{info}</p>}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : masters.length === 0 ? (
          <p className="ui-empty">作業マスタがまだ登録されていません。</p>
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  <th className="is-numeric">表示順</th>
                  <th className="is-numeric">ID</th>
                  <th>作業タイトル</th>
                  <th>管轄／担当会社</th>
                  <th>実施月</th>
                  <th>入室</th>
                  <th>報知</th>
                </tr>
              </thead>
              <tbody>
                {masters.map((m) => (
                  <tr
                    key={m.id}
                    className={`bilmen-row${m.disabled ? ' is-disabled' : ''}${readOnly ? '' : ' is-clickable'}`}
                    onClick={readOnly ? undefined : () => setEditing(m)}
                  >
                    <td className="is-numeric">{m.sort_order}</td>
                    <td className="is-numeric">{m.master_no}</td>
                    <td>
                      {m.title}
                      {m.title_note && <span className="bilmen-title-note">{m.title_note}</span>}
                      {m.disabled && <span className="ui-badge">無効</span>}
                    </td>
                    <td>
                      <span className="bilmen-cell-stack">
                        <span className="bilmen-sub">{m.jurisdiction || ''}</span>
                        <span className="bilmen-main">{m.vendor_name || ''}</span>
                      </span>
                    </td>
                    <td>
                      {formatMonths(m.months)}
                      {m.day_pattern && <span className="bilmen-pattern">{m.day_pattern}</span>}
                      {m.cycle_pattern && <span className="bilmen-pattern">{m.cycle_pattern}</span>}
                    </td>
                    <td>{m.enter_room ? '✓' : ''}</td>
                    <td>{m.notify ? '✓' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <BilmenMasterForm
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          vendorOptions={vendorOptions}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
          onDeleted={handleSaved}
        />
      )}
    </div>
  )
}
