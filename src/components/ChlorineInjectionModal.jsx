import { useEffect, useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { fetchChlorineInjectionLevels, saveChlorineInjectionLevels, todayJST } from '../lib/reports'

// BKB塩素注入レベルの編集モーダル（2026-11-24）。BKBの水道水へ塩素を注入する機器の設定値を
// 「変更した日・変更後のレベル」の一覧で管理する。残留塩素濃度の推移グラフに、各月末時点の
// レベルが薄い黄色の棒（右軸）で重なる。一覧は丸ごと保存する（行の追加・修正・削除をまとめて反映）。
let rowSeq = 0
const toRow = (l) => ({ id: ++rowSeq, date: l.date, level: String(l.level) })

export default function ChlorineInjectionModal({ readOnly, onClose, onSaved }) {
  useBodyScrollLock()

  const [rows, setRows] = useState([])
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetchChlorineInjectionLevels()
      .then((data) => {
        if (!active) return
        // 新しい変更が上に来るよう逆順で並べる
        setRows([...(data.levels || [])].reverse().map(toRow))
        setMeta(data)
      })
      .catch((err) => active && setError(err.message))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [])

  function updateRow(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  function addRow() {
    const last = rows[0]
    setRows((prev) => [{ id: ++rowSeq, date: todayJST(), level: last ? last.level : '' }, ...prev])
  }

  async function handleSave() {
    setError('')
    const levels = []
    for (const r of rows) {
      const level = r.level.trim()
      if (!r.date && !level) continue // 未入力の行は捨てる
      if (!r.date) return setError('日付が空の行があります')
      if (level === '' || !Number.isFinite(Number(level))) return setError(`${r.date} の注入レベルを数字で入れてください`)
      levels.push({ date: r.date, level: Number(level) })
    }
    const dates = levels.map((l) => l.date)
    if (new Set(dates).size !== dates.length) return setError('同じ日付の行が2つあります')
    setSaving(true)
    try {
      const saved = await saveChlorineInjectionLevels(levels.sort((a, b) => (a.date < b.date ? -1 : 1)))
      onSaved(saved.levels)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">BKB塩素注入レベル</h3>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <div className="ui-modal-body">
          {error && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {error}
            </p>
          )}
          <p className="ui-note">
            BKBの水道水に塩素を注入する機器の設定値です。設定を変えた日と変更後の値を入れてください。
            グラフには各月末時点（今月は今日時点）の値が棒で表示されます。
          </p>
          {loading ? (
            <p className="dashboard-loading">読み込み中…</p>
          ) : (
            <>
              {!readOnly && (
                <button type="button" className="btn-plain chlorine-injection-add" onClick={addRow}>
                  ＋ 変更を追加
                </button>
              )}
              <table className="chlorine-injection-table">
                <thead>
                  <tr>
                    <th>変更日</th>
                    <th>注入レベル</th>
                    {!readOnly && <th aria-label="削除" />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <input
                          type="date"
                          className="ui-input"
                          value={r.date}
                          disabled={readOnly}
                          onChange={(e) => updateRow(r.id, { date: e.target.value })}
                          aria-label="変更日"
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          inputMode="decimal"
                          className="ui-input chlorine-injection-level"
                          value={r.level}
                          disabled={readOnly}
                          onChange={(e) => updateRow(r.id, { level: e.target.value })}
                          aria-label="注入レベル"
                        />
                      </td>
                      {!readOnly && (
                        <td>
                          <button
                            type="button"
                            className="icon-btn-close"
                            onClick={() => setRows((prev) => prev.filter((x) => x.id !== r.id))}
                            aria-label={`${r.date} の行を削除`}
                            title="この行を削除"
                          >
                            ×
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={3} className="settings-hint">
                        まだ登録がありません。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {meta?.updated_at && (
                <p className="settings-hint">
                  最終更新: {new Date(meta.updated_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
                  {meta.updated_by_name ? `（${meta.updated_by_name}）` : ''}
                </p>
              )}
            </>
          )}
        </div>
        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start" />
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose}>
              {readOnly ? '閉じる' : 'キャンセル'}
            </button>
            {!readOnly && (
              <button type="button" className="btn-primary" onClick={handleSave} disabled={loading || saving}>
                {saving ? '保存中…' : '保存する'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
