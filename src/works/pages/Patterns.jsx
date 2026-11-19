// 出退勤パターン（現行: 出退勤パターン_勤怠）
import { useState } from 'react'
import Modal from '../components/Modal.jsx'
import { useList } from '../components/useList.js'
import { api, hhmm } from '../lib/api.js'

export default function Patterns() {
  const { items, error, reload } = useList('/api/works/patterns')
  const [edit, setEdit] = useState(null)
  const [showStopped, setShowStopped] = useState(false)
  const list = (items || []).filter((p) => showStopped || p.active)

  return (
    <>
      <div className="works-sticky">
        <h1 className="works-title">出退勤パターン</h1>
        <div className="works-row-actions">
          <button type="button" className="btn-primary works-btn-accent" onClick={() => setEdit({ name: '', start_time: '09:00', end_time: '17:00', active: true })}>
            ＋ 新しいパターン
          </button>
          <label className="works-muted">
            <input type="checkbox" checked={showStopped} onChange={(e) => setShowStopped(e.target.checked)} /> 停止中も表示
          </label>
        </div>
      </div>
      {error && <p className="works-error">{error}</p>}
      <div className="ui-table-wrap works-scroll">
        <table className="ui-table works-clickable">
          <thead>
            <tr><th>タイプ名</th><th>出勤予定</th><th>退勤予定</th><th>状態</th></tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id} onClick={() => setEdit({ ...p, start_time: hhmm(p.start_time), end_time: hhmm(p.end_time) })}>
                <td>{p.name}</td>
                <td>{hhmm(p.start_time)}</td>
                <td>{hhmm(p.end_time)}</td>
                <td>{p.active ? '使用中' : <span className="ui-badge">停止</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {items && list.length === 0 && <div className="ui-empty">パターンがありません</div>}
      </div>
      {edit && <PatternForm value={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload() }} />}
    </>
  )
}

function PatternForm({ value, onClose, onSaved }) {
  const [v, setV] = useState(value)
  const [error, setError] = useState('')
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const save = async () => {
    try {
      await api('/api/works/patterns', { method: v.id ? 'PATCH' : 'POST', body: v })
      onSaved()
    } catch (e) {
      setError(e.message)
    }
  }
  return (
    <Modal
      title={v.id ? 'パターンを変更' : 'パターンを登録'}
      onClose={onClose}
      foot={<div className="ui-modal-foot-end"><button type="button" className="btn-primary works-btn-accent" onClick={save}>保存</button></div>}
    >
      <label className="ui-field"><span>タイプ名</span><input className="ui-input" value={v.name} onChange={set('name')} /></label>
      <div className="ui-field-row">
        <label className="ui-field"><span>出勤予定時刻</span><input className="ui-input" type="time" value={v.start_time} onChange={set('start_time')} /></label>
        <label className="ui-field"><span>退勤予定時刻</span><input className="ui-input" type="time" value={v.end_time} onChange={set('end_time')} /></label>
      </div>
      <label><input type="checkbox" checked={v.active} onChange={set('active')} /> 使用中（外すと新しい予定には使いません）</label>
      {error && <div className="works-error">{error}</div>}
    </Modal>
  )
}
