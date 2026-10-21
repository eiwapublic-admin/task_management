import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconPencil } from './Icons'
import {
  HISTORY_CONFLICT_MESSAGE,
  TENANT_PROFILE_FIELDS,
  askChangeReason,
  fetchMeterHistory,
  revertMeterHistory,
  saveMeterHistoryReason,
} from '../lib/meter'

// 検針マスタ（テナント・メータ・空調機）の変更履歴（2026-10-21〜。記録は DB のトリガー）。
// テナントの入れ替えの経緯を残し、誤った修正は「取り消す」で変更前の値に戻す（変わった項目だけ）。
// 変更理由は保存のときにダイアログで入れるか、ここで後から書き足す（2026-10-21〜）。
// table・rowKey を渡すとその1件の履歴だけ（入力画面の下）、渡さなければ全件の新しい順（検針マスタの「変更履歴」タブ）

const TABLE_LABELS = {
  equipment_tenants: 'テナント',
  meters: 'メータ',
  meter_ac_units: '空調機',
}

const FIELD_LABELS = {
  equipment_tenants: {
    billing_code: '請求先コード',
    name: '正式名称',
    short_name: '略称',
    floor: '階',
    moved_in_on: '入居年月日',
    moved_out_on: '退去日',
    moved_out: '退去済み',
    first_month_billable: '初月無料にしない',
    notice_emails: '案内メールの宛先',
    note: '備考',
    profile: '基本情報',
    default_item_id: '既定の備品',
    source: '登録元',
  },
  meters: {
    meter_no: 'メータ番号',
    tenant_id: 'テナント',
    seq: 'テナント内連番',
    sort_order: '表示順',
    room_name: '貸室名',
    detail_note: '請求明細補足',
    seal_label: 'メータシール表記',
    measured: '計測対象',
    oa_share: '外調機電気量を按分',
    is_oa_meter: '外調機メータ',
    removed: '検針機撤去済み',
    note: '備考',
    digits: 'メータ桁数',
    expires_on: '有効期限',
    floor: '階',
    room_no: '部屋番号',
    kind: '検針内容',
    area_m2: '部屋面積（㎡）',
    area_tsubo: '部屋面積（坪）',
  },
  meter_ac_units: { address: 'アドレス', meter_id: '割当てメータ' },
}
const PROFILE_LABELS = Object.fromEntries([...TENANT_PROFILE_FIELDS.map((f) => [f.key, f.label]), ['emergency_contacts', '緊急連絡先']])
const HIDDEN = new Set(['id', 'unit_no', 'created_at', 'updated_at', 'updated_by', 'synced_at', 'oa_ratio', 'max_value', 'legacy_id'])

function formatAt(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString()
  return `${d.slice(0, 10).replaceAll('-', '/')} ${d.slice(11, 16)}`
}

export default function MeterHistoryList({ table = null, rowKey = null, tenants = [], meters = [], onReverted = null, limit = 200 }) {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [kind, setKind] = useState('')

  const tenantById = useMemo(() => new Map(tenants.map((t) => [t.id, t])), [tenants])
  const meterById = useMemo(() => new Map(meters.map((m) => [m.id, m])), [meters])

  const load = useCallback(async () => {
    setError('')
    try {
      setItems(
        await fetchMeterHistory({
          table: table || kind || undefined,
          key: rowKey ?? undefined,
          limit,
        }),
      )
    } catch (err) {
      setError(err.message)
    }
  }, [table, rowKey, kind, limit])

  useEffect(() => {
    load()
  }, [load])

  function show(tableName, field, v) {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return '（空）'
    if (typeof v === 'boolean') return v ? 'はい' : 'いいえ'
    if (field === 'tenant_id') {
      const t = tenantById.get(v)
      return t ? `${t.billing_code || ''} ${t.short_name || t.name}`.trim() : '（不明なテナント）'
    }
    if (field === 'meter_id') return meterById.get(v)?.meter_no || '（不明なメータ）'
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return String(v).replaceAll('-', '/')
    if (Array.isArray(v)) return v.join(', ')
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v)
  }

  // 1件の変更を「項目: 前 → 後」の並びにする。基本情報（profile）は中の項目ごとに
  function diffLines(h) {
    const labels = FIELD_LABELS[h.table_name] || {}
    const lines = []
    const fields =
      h.op === 'update'
        ? h.changed_fields || []
        : Object.keys(labels).filter((f) => {
            const v = (h.new_row || h.old_row)?.[f]
            return v != null && v !== '' && !(Array.isArray(v) && !v.length) && typeof v !== 'object'
          })
    for (const f of fields) {
      if (HIDDEN.has(f)) continue
      if (f === 'profile' && h.op === 'update') {
        const o = h.old_row?.profile || {}
        const n = h.new_row?.profile || {}
        for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
          if (JSON.stringify(o[k] ?? null) === JSON.stringify(n[k] ?? null)) continue
          const fmt = (v) =>
            k === 'emergency_contacts'
              ? (v || [])
                  .map((c) => c.name)
                  .filter(Boolean)
                  .join('・') || '（空）'
              : show(h.table_name, k, v)
          lines.push({
            label: `基本情報: ${PROFILE_LABELS[k] || k}`,
            from: fmt(o[k]),
            to: fmt(n[k]),
          })
        }
        continue
      }
      lines.push({
        label: labels[f] || f,
        from: h.op === 'insert' ? null : show(h.table_name, f, h.old_row?.[f]),
        to: h.op === 'delete' ? null : show(h.table_name, f, h.new_row?.[f]),
      })
    }
    return lines
  }

  function targetLabel(h) {
    const r = h.new_row || h.old_row || {}
    if (h.table_name === 'equipment_tenants') return `${r.billing_code || ''} ${r.short_name || r.name || ''}`.trim()
    if (h.table_name === 'meters') return `メータ ${r.meter_no || ''}`
    return `空調機 ${r.unit_no}（${r.address || ''}）`
  }

  async function revert(h) {
    const reason = askChangeReason(
      `${formatAt(h.changed_at)} の変更を取り消して、変わった項目を変更前の値に戻します。\n取り消す理由を入力して OK を押してください（任意）`,
    )
    if (reason === null) return
    setBusyId(h.id)
    setError('')
    try {
      try {
        await revertMeterHistory(h.id, { reason })
      } catch (err) {
        if (!err.message.startsWith(HISTORY_CONFLICT_MESSAGE)) throw err
        if (!window.confirm('この変更のあとで、同じ項目がさらに変わっています。それでも変更前の値に戻しますか？')) return
        await revertMeterHistory(h.id, { force: true, reason })
      }
      await load()
      onReverted?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  async function editReason(h) {
    const r = window.prompt('変更理由（空にすると消します）', h.reason || '')
    if (r == null) return
    setBusyId(h.id)
    setError('')
    try {
      const saved = await saveMeterHistoryReason(h.id, r.trim())
      setItems((list) => list.map((x) => (x.id === h.id ? { ...x, reason: saved.reason } : x)))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="meter-history">
      {!table && (
        <div className="meter-list-options">
          <select className="ui-select meter-history-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">すべて</option>
            {Object.entries(TABLE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <span className="ui-note">新しい順に最大{limit}件。2026/10/21 から記録しています。</span>
        </div>
      )}
      {error && <p className="ui-note is-danger">{error}</p>}
      {!items ? (
        <p className="ui-note">読み込み中…</p>
      ) : items.length === 0 ? (
        <p className="ui-note">変更の記録はまだありません。</p>
      ) : (
        <ul className="meter-history-list">
          {items.map((h) => {
            const lines = diffLines(h)
            return (
              <li key={h.id} className="meter-history-item">
                <div className="meter-history-head">
                  <span className="meter-history-at">{formatAt(h.changed_at)}</span>
                  {!table && <span className="ui-badge">{TABLE_LABELS[h.table_name]}</span>}
                  {!table && <strong>{targetLabel(h)}</strong>}
                  <span className={`ui-badge${h.op === 'update' ? '' : ' is-warn'}`}>
                    {h.op === 'insert' ? '追加' : h.op === 'delete' ? '削除' : '修正'}
                  </span>
                  <span className="meter-history-by">{h.changed_by || '（不明）'}</span>
                  {h.op === 'update' && (
                    <button type="button" className="btn-plain meter-history-revert" onClick={() => revert(h)} disabled={busyId != null}>
                      {busyId === h.id ? '取り消し中…' : '取り消す'}
                    </button>
                  )}
                </div>
                <div className="meter-history-reason">
                  <span className="meter-history-label">変更理由</span>
                  {h.reason ? <span>{h.reason}</span> : <span className="meter-history-none">（なし）</span>}
                  <button
                    type="button"
                    className="meter-history-reason-btn"
                    onClick={() => editReason(h)}
                    disabled={busyId != null}
                    aria-label={h.reason ? '変更理由を直す' : '変更理由を書く'}
                    title={h.reason ? '変更理由を直す' : '変更理由を書く'}
                  >
                    <IconPencil size={16} />
                  </button>
                </div>
                {lines.length > 0 && (
                  <ul className="meter-history-diff">
                    {lines.map((l, i) => (
                      <li key={i}>
                        <span className="meter-history-label">{l.label}</span>
                        {l.from != null && <span className="meter-history-from">{l.from}</span>}
                        {l.from != null && l.to != null && <span aria-hidden="true"> → </span>}
                        {l.to != null && <span className="meter-history-to">{l.to}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
