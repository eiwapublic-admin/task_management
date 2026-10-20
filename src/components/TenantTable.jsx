import { Fragment, useMemo } from 'react'
import { formatDate, groupTenantsByFloor, jstToday } from '../lib/tenants'
import './TenantTable.css'

function floorHead(floor) {
  return floor ? (floor === 'B' ? 'B1F' : `${floor}F`) : '階なし（共用エリアなど）'
}

// テナントマスタの一覧（2026-10-20〜。テナントマスタ画面と検針マスタのテナントタブで共通）。
// 階ごとにまとめ、退去済みは各階の末尾に灰色で出す。列見出しはスクロールしても固定表示する
// （PC は機能ヘッダの下に、スマートフォンは表の枠の中で。sticky-header-overflow-trap 参照）。
// onEdit を渡さなければ参照だけ（行を押しても何も起きない）。meterCount を渡すとメータの台数の列を出す
export default function TenantTable({ tenants, includeMovedOut, meterCount = null, onEdit = null }) {
  const today = jstToday()
  const groups = useMemo(() => groupTenantsByFloor(tenants, { includeMovedOut, today }), [tenants, includeMovedOut, today])
  const columns = 7 + (meterCount ? 1 : 0)

  if (groups.length === 0) return <p className="ui-empty">テナントがありません。</p>

  return (
    <div className="ui-table-wrap tenant-table-wrap">
      <table className="ui-table tenant-table">
        <thead>
          <tr>
            <th>請求先コード</th>
            <th>正式名称</th>
            <th>略称</th>
            <th>入居年月日</th>
            <th>退去日</th>
            {meterCount && <th className="is-numeric">メータ</th>}
            <th>状態</th>
            <th>備考</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.floor}>
              <tr className="ui-table-group-head">
                <td colSpan={columns}>{floorHead(g.floor)}</td>
              </tr>
              {g.rows.map(({ tenant: t, movedOut, movingOut }) => (
                <tr
                  key={t.id}
                  className={`tenant-row${onEdit ? ' is-clickable' : ''}${movedOut ? ' is-moved-out' : ''}`}
                  onClick={onEdit ? () => onEdit(t) : undefined}
                >
                  <td>{t.billing_code || '—'}</td>
                  <td className="tenant-name-cell">{t.name}</td>
                  <td>{t.short_name || ''}</td>
                  <td>{formatDate(t.moved_in_on)}</td>
                  <td>{formatDate(t.moved_out_on)}</td>
                  {meterCount && <td className="is-numeric">{meterCount.get(t.id) || ''}</td>}
                  <td>
                    {movedOut && <span className="ui-badge">退去済み</span>}
                    {movingOut && <span className="ui-badge is-warn">退去予定</span>}
                    {t.first_month_billable && <span className="ui-badge is-warn">初月無料にしない</span>}
                  </td>
                  <td className="tenant-note-cell">{t.note || ''}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}
