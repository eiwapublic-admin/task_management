// スタッフ（現行: eSales 担当者マスタ＋勤怠システムの従業員。決定事項 13）
// 詳細では 基本情報・勤務体系（適用開始日つき）・招待（初回登録・パスワード再設定）を扱う
import { useEffect, useState } from 'react'
import Modal from '../components/Modal.jsx'
import { useList } from '../components/useList.js'
import { api, hhmm, STATUS_LABEL, WEEKDAYS } from '../lib/api.js'

export default function Staff() {
  const { items, error, reload } = useList('/api/works/staff')
  const { items: patterns } = useList('/api/works/patterns')
  const { items: sites } = useList('/api/works/sites')
  const [filter, setFilter] = useState('current')
  const [open, setOpen] = useState(null)
  const list = (items || []).filter((s) => filter === 'all' || s.status !== 'retired')

  return (
    <>
      <div className="works-sticky">
        <h1 className="works-title">スタッフ</h1>
        <div className="works-row-actions">
          <button type="button" className="btn-primary works-btn-accent" onClick={() => setOpen({ code: '', name: '', kana: '', dept: '', hired_on: '', status: 'active', default_pattern_id: '', closed_day_work: false, note: '' })}>
            ＋ 新しいスタッフ
          </button>
          <div className="ui-segmented">
            <button type="button" className={`ui-segmented-btn ${filter === 'current' ? 'is-active' : ''}`} onClick={() => setFilter('current')}>在籍・休職</button>
            <button type="button" className={`ui-segmented-btn ${filter === 'all' ? 'is-active' : ''}`} onClick={() => setFilter('all')}>退職者も表示</button>
          </div>
        </div>
      </div>
      {error && <p className="works-error">{error}</p>}
      <div className="ui-table-wrap works-scroll">
        <table className="ui-table works-clickable">
          <thead>
            <tr><th>コード</th><th>氏名</th><th>所属</th><th>休館日勤務</th><th>状態</th><th>アプリ</th></tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id} onClick={() => setOpen(s)}>
                <td>{s.code}</td>
                <td><strong>{s.name}</strong></td>
                <td>{s.dept}</td>
                <td>{s.closed_day_work ? '勤務する' : <span className="works-muted">—</span>}</td>
                <td>{s.status === 'active' ? STATUS_LABEL.active : <span className={`ui-badge ${s.status === 'leave' ? 'is-warn' : ''}`}>{STATUS_LABEL[s.status]}</span>}</td>
                <td>{s.user_id ? '登録済み' : <span className="works-muted">未登録</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {items && list.length === 0 && <div className="ui-empty">スタッフがいません</div>}
      </div>
      {open && (
        <StaffDetail
          value={open}
          patterns={patterns || []}
          sites={sites || []}
          onClose={() => setOpen(null)}
          onSaved={(item) => { reload(); if (item) setOpen(item) }}
        />
      )}
    </>
  )
}

function StaffDetail({ value, patterns, sites, onClose, onSaved }) {
  const [tab, setTab] = useState('basic')
  const isNew = !value.id
  return (
    <Modal title={isNew ? 'スタッフを登録' : `${value.code} ${value.name}`} onClose={onClose} size="lg">
      {!isNew && (
        <div className="ui-segmented">
          {[['basic', '基本情報'], ['schedule', '勤務体系'], ['invite', 'アプリの利用']].map(([k, label]) => (
            <button key={k} type="button" className={`ui-segmented-btn ${tab === k ? 'is-active' : ''}`} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
      )}
      {tab === 'basic' && <BasicForm value={value} patterns={patterns} onSaved={onSaved} />}
      {tab === 'schedule' && <Schedules staff={value} patterns={patterns} sites={sites} />}
      {tab === 'invite' && <Invites staff={value} />}
    </Modal>
  )
}

function BasicForm({ value, patterns, onSaved }) {
  const [v, setV] = useState({ ...value, hired_on: value.hired_on || '', default_pattern_id: value.default_pattern_id || '' })
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value })
  const save = async () => {
    setError('')
    setMsg('')
    try {
      const { item } = await api('/api/works/staff', { method: v.id ? 'PATCH' : 'POST', body: v })
      setV({ ...item, hired_on: item.hired_on || '', default_pattern_id: item.default_pattern_id || '' })
      setMsg('保存しました')
      onSaved(item)
    } catch (e) {
      setError(e.message)
    }
  }
  return (
    <>
      <div className="works-grid-2">
        <label className="ui-field"><span>担当者コード</span><input className="ui-input" value={v.code} onChange={set('code')} /></label>
        <label className="ui-field"><span>氏名</span><input className="ui-input" value={v.name} onChange={set('name')} /></label>
        <label className="ui-field"><span>ふりがな</span><input className="ui-input" value={v.kana || ''} onChange={set('kana')} /></label>
        <label className="ui-field"><span>所属コード</span><input className="ui-input" value={v.dept || ''} onChange={set('dept')} /></label>
        <label className="ui-field"><span>入社日（有休の付与に使います）</span><input className="ui-input" type="date" value={v.hired_on} onChange={set('hired_on')} /></label>
        <label className="ui-field">
          <span>在籍状態</span>
          <select className="ui-select" value={v.status} onChange={set('status')}>
            {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="ui-field">
          <span>標準の出退勤パターン</span>
          <select className="ui-select" value={v.default_pattern_id} onChange={set('default_pattern_id')}>
            <option value="">（なし）</option>
            {patterns.filter((p) => p.active || p.id === v.default_pattern_id).map((p) => (
              <option key={p.id} value={p.id}>{p.name}（{hhmm(p.start_time)}〜{hhmm(p.end_time)}）</option>
            ))}
          </select>
        </label>
        <label className="ui-field"><span>メモ</span><input className="ui-input" value={v.note || ''} onChange={set('note')} /></label>
      </div>
      <label>
        <input type="checkbox" checked={!!v.closed_day_work} onChange={(e) => setV({ ...v, closed_day_work: e.target.checked })} /> 休館日も勤務する
        <span className="works-muted">（オンにすると、日報カレンダーの休館日にも予定を作ります）</span>
      </label>
      <p className="ui-note">電話番号・住所などの個人情報はこのシステムには登録しません。</p>
      {error && <div className="works-error">{error}</div>}
      <div className="works-row-actions">
        <button type="button" className="btn-primary works-btn-accent" onClick={save}>保存</button>
        {msg && <span className="works-muted">{msg}</span>}
      </div>
    </>
  )
}

const emptySchedule = () => ({
  valid_from: new Date().toISOString().slice(0, 10),
  main_site_id: '',
  weekday_pattern_ids: [null, null, null, null, null, null, null],
  break_overrides: [],
  holiday_work: false,
  commute_allowance: false,
})

function Schedules({ staff, patterns, sites }) {
  const path = `/api/works/schedules?staff_id=${staff.id}`
  const [items, setItems] = useState(null)
  const [edit, setEdit] = useState(null)
  const [error, setError] = useState('')
  const reload = () => api(path).then((d) => setItems(d.items)).catch((e) => setError(e.message))
  useEffect(() => {
    api(path).then((d) => setItems(d.items)).catch((e) => setError(e.message))
  }, [path])
  const patternName = (id) => patterns.find((p) => p.id === id)?.name || ''
  const siteName = (id) => sites.find((s) => s.id === id)?.name || ''

  const save = async () => {
    setError('')
    try {
      await api('/api/works/schedules', { method: 'POST', body: { ...edit, staff_id: staff.id } })
      setEdit(null)
      reload()
    } catch (e) {
      setError(e.message)
    }
  }
  const remove = async (id) => {
    try {
      await api(`/api/works/schedules?id=${id}`, { method: 'DELETE' })
      reload()
    } catch (e) {
      setError(e.message)
    }
  }

  if (edit) {
    const setDay = (i, val) => setEdit({ ...edit, weekday_pattern_ids: edit.weekday_pattern_ids.map((x, j) => (j === i ? val || null : x)) })
    return (
      <>
        <div className="works-grid-2">
          <label className="ui-field"><span>適用開始日</span><input className="ui-input" type="date" value={edit.valid_from} onChange={(e) => setEdit({ ...edit, valid_from: e.target.value })} /></label>
          <label className="ui-field">
            <span>主な現場</span>
            <select className="ui-select" value={edit.main_site_id || ''} onChange={(e) => setEdit({ ...edit, main_site_id: e.target.value })}>
              <option value="">（なし）</option>
              {sites.filter((s) => s.active || s.id === edit.main_site_id).map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
            </select>
          </label>
        </div>
        <div className="ui-label">曜日ごとの出退勤パターン（空欄は休み）</div>
        <div className="works-week">
          {WEEKDAYS.map((w, i) => (
            <label key={w} className="ui-field">
              <span>{w}</span>
              <select className="ui-select" value={edit.weekday_pattern_ids[i] || ''} onChange={(e) => setDay(i, e.target.value)}>
                <option value="">休み</option>
                {patterns.filter((p) => p.active || p.id === edit.weekday_pattern_ids[i]).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          ))}
        </div>
        <div className="ui-label">例外の休憩（曜日ごと。通常は設定の休憩時間帯を使います）</div>
        {edit.break_overrides.map((o, i) => (
          <div key={i} className="works-row-actions">
            <select className="ui-select" style={{ width: 'auto' }} value={o.dow} onChange={(e) => setEdit({ ...edit, break_overrides: edit.break_overrides.map((x, j) => (j === i ? { ...x, dow: Number(e.target.value) } : x)) })}>
              {WEEKDAYS.map((w, d) => <option key={w} value={d}>{w}</option>)}
            </select>
            <input className="ui-input" style={{ width: 'auto' }} type="time" value={o.start} onChange={(e) => setEdit({ ...edit, break_overrides: edit.break_overrides.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)) })} />
            〜
            <input className="ui-input" style={{ width: 'auto' }} type="time" value={o.end} onChange={(e) => setEdit({ ...edit, break_overrides: edit.break_overrides.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)) })} />
            <button type="button" className="btn-plain" onClick={() => setEdit({ ...edit, break_overrides: edit.break_overrides.filter((_, j) => j !== i) })}>削除</button>
          </div>
        ))}
        <div>
          <button type="button" className="btn-plain" onClick={() => setEdit({ ...edit, break_overrides: [...edit.break_overrides, { dow: 1, start: '12:00', end: '12:30' }] })}>＋ 例外の休憩を追加</button>
        </div>
        <label><input type="checkbox" checked={edit.holiday_work} onChange={(e) => setEdit({ ...edit, holiday_work: e.target.checked })} /> 祝日も予定を入れる</label>
        <label><input type="checkbox" checked={edit.commute_allowance} onChange={(e) => setEdit({ ...edit, commute_allowance: e.target.checked })} /> 通勤手当の対象</label>
        {error && <div className="works-error">{error}</div>}
        <div className="works-row-actions">
          <button type="button" className="btn-primary works-btn-accent" onClick={save}>保存</button>
          <span className="ui-note">同じ適用開始日がすでにあれば上書きします</span>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="works-row-actions">
        <button type="button" className="btn-primary works-btn-accent" onClick={() => setEdit(items?.[0] ? { ...items[0], valid_from: emptySchedule().valid_from } : emptySchedule())}>
          ＋ 新しい勤務体系（適用開始日から）
        </button>
      </div>
      {error && <div className="works-error">{error}</div>}
      {items && items.length === 0 && <div className="ui-empty">勤務体系がまだありません</div>}
      {(items || []).map((s, idx) => (
        <div key={s.id} className={`ui-card ${idx === 0 ? 'works-today' : ''}`}>
          <div className="ui-card-title">
            {s.valid_from} から{idx === 0 ? '（最新）' : ''}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button type="button" className="btn-plain" onClick={() => setEdit({ ...s, main_site_id: s.main_site_id || '' })}>変更</button>
              <button type="button" className="btn-plain" onClick={() => remove(s.id)}>削除</button>
            </span>
          </div>
          <div className="works-muted">主な現場: {siteName(s.main_site_id) || 'なし'}</div>
          <div className="works-week" style={{ marginTop: 8 }}>
            {WEEKDAYS.map((w, i) => (
              <div key={w}><strong>{w}</strong> {patternName(s.weekday_pattern_ids?.[i]) || <span className="works-muted">休み</span>}</div>
            ))}
          </div>
          <div className="works-muted" style={{ marginTop: 8 }}>
            {s.break_overrides?.length ? `例外休憩: ${s.break_overrides.map((o) => `${WEEKDAYS[o.dow]} ${o.start}〜${o.end}`).join('、')}　` : ''}
            {s.holiday_work ? '祝日も勤務　' : ''}
            {s.commute_allowance ? '通勤手当あり' : ''}
          </div>
        </div>
      ))}
    </>
  )
}

function Invites({ staff }) {
  const path = `/api/works/invites?staff_id=${staff.id}`
  const [items, setItems] = useState(null)
  const [link, setLink] = useState(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const reload = () => api(path).then((d) => setItems(d.items)).catch((e) => setError(e.message))
  useEffect(() => {
    api(path).then((d) => setItems(d.items)).catch((e) => setError(e.message))
  }, [path])
  const registered = !!staff.user_id

  const issue = async () => {
    setError('')
    setCopied(false)
    try {
      setLink(await api('/api/works/invites', { method: 'POST', body: { staff_id: staff.id, kind: registered ? 'reset' : 'register' } }))
      reload()
    } catch (e) {
      setError(e.message)
    }
  }
  const revoke = async (id) => {
    try {
      await api(`/api/works/invites?id=${id}`, { method: 'DELETE' })
      setLink(null)
      reload()
    } catch (e) {
      setError(e.message)
    }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  const state = (i) =>
    i.used_at ? '使用済み' : i.revoked_at ? '取り消し' : new Date(i.expires_at) < new Date() ? '期限切れ' : '有効'

  return (
    <>
      <p style={{ margin: 0 }}>
        {registered ? 'このスタッフはアプリに登録済みです。パスワードを忘れたときは「再設定のリンク」を発行して本人に送ってください。' : 'まだアプリに登録されていません。「招待リンク」を発行して本人に送ると、本人がログインIDとパスワードを決めて使い始められます。'}
      </p>
      {staff.status === 'retired' ? (
        <p className="works-muted">退職のスタッフには発行できません。</p>
      ) : (
        <div className="works-row-actions">
          <button type="button" className="btn-primary works-btn-accent" onClick={issue}>
            {registered ? '再設定のリンクを発行' : '招待リンクを発行'}
          </button>
        </div>
      )}
      {link && (
        <div className="ui-card">
          <div className="ui-card-title">リンク（この画面を閉じると二度と表示できません）</div>
          <div className="works-link-box">{link.url}</div>
          <div className="works-row-actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn-plain" onClick={copy}>{copied ? 'コピーしました' : 'コピー'}</button>
            <span className="works-muted">有効期限: {new Date(link.expires_at).toLocaleString('ja-JP')}（1 回使うと無効）</span>
          </div>
          <p className="ui-note">LINE やメールで本人だけに送ってください。新しく発行すると、前のリンクは使えなくなります。</p>
        </div>
      )}
      {error && <div className="works-error">{error}</div>}
      {items && items.length > 0 && (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead><tr><th>発行日時</th><th>種類</th><th>有効期限</th><th>状態</th><th /></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{new Date(i.created_at).toLocaleString('ja-JP')}</td>
                  <td>{i.kind === 'reset' ? '再設定' : '招待'}</td>
                  <td>{new Date(i.expires_at).toLocaleString('ja-JP')}</td>
                  <td>{state(i)}</td>
                  <td>{state(i) === '有効' && <button type="button" className="btn-plain" onClick={() => revoke(i.id)}>取り消す</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
