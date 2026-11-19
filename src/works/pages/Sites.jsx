// 現場（現行: 作業マスタ）。位置（緯度・経度）は QR 打刻の持ち出し対策に使う（Phase 3）
import { lazy, Suspense, useState } from 'react'
import Modal from '../components/Modal.jsx'
import { useList } from '../components/useList.js'
import { api } from '../lib/api.js'

// QR の作成（ZXing）は発行のときだけ読み込む
const QrSheet = lazy(() => import('../components/QrSheet.jsx'))

export default function Sites() {
  const { items, error, reload } = useList('/api/works/sites')
  const [edit, setEdit] = useState(null)
  const [qr, setQr] = useState(null)
  const [qrError, setQrError] = useState('')
  const issue = async (s, mode = 'issue') => {
    const msg = mode === 'print' ? null : s.has_qr
      ? `${s.code} ${s.name} の QR を再発行します。\nいま掲示している QR は使えなくなります。よろしいですか？`
      : `${s.code} ${s.name} の QR を発行します。よろしいですか？`
    if (msg && !window.confirm(msg)) return
    setQrError('')
    try {
      const r = await api('/api/works/sites/qr', { method: 'POST', body: { id: s.id, mode } })
      setQr(r)
      reload()
    } catch (e) {
      setQrError(e.message)
    }
  }
  return (
    <>
      <div className="works-sticky">
        <h1 className="works-title">現場</h1>
        <div className="works-row-actions">
          <button type="button" className="btn-primary works-btn-accent" onClick={() => setEdit({ code: '', name: '', detail: '', address: '', lat: '', lng: '', radius_m: 300, active: true })}>
            ＋ 新しい現場
          </button>
        </div>
      </div>
      {error && <p className="works-error">{error}</p>}
      {qrError && <p className="works-error">{qrError}</p>}
      <div className="ui-table-wrap works-scroll">
        <table className="ui-table works-clickable">
          <thead>
            <tr><th>作業コード</th><th>作業名称</th><th>作業詳細</th><th>位置</th><th>QR</th><th>状態</th><th /></tr>
          </thead>
          <tbody>
            {(items || []).map((s) => (
              <tr key={s.id} onClick={() => setEdit({ ...s, lat: s.lat ?? '', lng: s.lng ?? '' })}>
                <td>{s.code}</td>
                <td>{s.name}</td>
                <td>{s.detail}</td>
                <td>{s.lat != null && s.lng != null ? `登録済み（${s.radius_m}m）` : <span className="works-muted">未登録</span>}</td>
                <td>{s.has_qr ? `発行済み（${new Date(s.qr_issued_at).toLocaleDateString('ja-JP')}）` : <span className="works-muted">未発行</span>}</td>
                <td>{s.active ? '使用中' : <span className="ui-badge">停止</span>}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {s.active && (
                    <div className="works-row-actions" style={{ margin: 0, flexWrap: 'nowrap' }}>
                      {s.has_qr && <button type="button" className="btn-plain" onClick={() => issue(s, 'print')}>QR を印刷</button>}
                      <button type="button" className="btn-plain" onClick={() => issue(s)}>{s.has_qr ? '再発行' : 'QR を発行'}</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items && items.length === 0 && <div className="ui-empty">現場がありません</div>}
      </div>
      {qr && <Suspense fallback={null}><QrSheet site={qr.site} token={qr.token} reprint={qr.reprint} onClose={() => setQr(null)} /></Suspense>}
      {edit && <SiteForm value={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload() }} />}
    </>
  )
}

function SiteForm({ value, onClose, onSaved }) {
  const [v, setV] = useState(value)
  const [error, setError] = useState('')
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const save = async () => {
    try {
      await api('/api/works/sites', { method: v.id ? 'PATCH' : 'POST', body: v })
      onSaved()
    } catch (e) {
      setError(e.message)
    }
  }
  return (
    <Modal
      title={v.id ? '現場を変更' : '現場を登録'}
      onClose={onClose}
      foot={<div className="ui-modal-foot-end"><button type="button" className="btn-primary works-btn-accent" onClick={save}>保存</button></div>}
    >
      <div className="ui-field-row">
        <label className="ui-field"><span>作業コード</span><input className="ui-input" value={v.code} onChange={set('code')} /></label>
        <label className="ui-field"><span>作業名称</span><input className="ui-input" value={v.name} onChange={set('name')} /></label>
      </div>
      <label className="ui-field"><span>作業詳細</span><input className="ui-input" value={v.detail || ''} onChange={set('detail')} /></label>
      <label className="ui-field"><span>住所</span><input className="ui-input" value={v.address || ''} onChange={set('address')} /></label>
      <div className="ui-field-row">
        <label className="ui-field"><span>緯度</span><input className="ui-input" inputMode="decimal" value={v.lat} onChange={set('lat')} /></label>
        <label className="ui-field"><span>経度</span><input className="ui-input" inputMode="decimal" value={v.lng} onChange={set('lng')} /></label>
        <label className="ui-field"><span>許容距離（m）</span><input className="ui-input" inputMode="numeric" value={v.radius_m} onChange={set('radius_m')} /></label>
      </div>
      <p className="ui-note">緯度・経度は、地図アプリで現場を長押しすると表示される数字を貼り付けます。QR 打刻（Phase 3）で、打刻した場所がこの距離の内側かを確かめます。</p>
      <label><input type="checkbox" checked={v.active} onChange={set('active')} /> 使用中</label>
      {error && <div className="works-error">{error}</div>}
    </Modal>
  )
}
