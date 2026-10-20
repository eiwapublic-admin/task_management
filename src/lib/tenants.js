// テナントマスタ（備品と検針で共有。equipment_tenants）の一覧の並べ方と退去の判定（2026-10-20〜）。
// 退去は退去日（moved_out_on）で表す。前もって入れておけば、その日が来るまでは入居中として扱う

// 日本時間の今日（YYYY-MM-DD）
export function jstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
}

// 退去済みか。退去日を過ぎていれば、サーバーの毎日の反映（3時）を待たずに退去済みとして扱う
export function isMovedOut(t, today = jstToday()) {
  return !!t.moved_out || (!!t.moved_out_on && t.moved_out_on <= today)
}

// 退去日が先の日付で入っている（退去予定）か
export function isMovingOut(t, today = jstToday()) {
  return !!t.moved_out_on && t.moved_out_on > today && !t.moved_out
}

// 階の並び（B、1F〜7F、階なし＝共用エリアなどは最後）
const FLOOR_RANK = new Map(['B', '1', '2', '3', '4', '5', '6', '7'].map((f, i) => [f, i]))
const floorRank = (f) => FLOOR_RANK.get(f || '') ?? 99

const byCode = (a, b) => (a.billing_code || '~').localeCompare(b.billing_code || '~', 'ja', { numeric: true })

/**
 * 階ごとにまとめる。各階の中は入居中（請求先コード順）→ 退去済み（請求先コード順）の順
 * @returns {{ floor: string, rows: { tenant: object, movedOut: boolean, movingOut: boolean }[] }[]}
 */
export function groupTenantsByFloor(tenants, { includeMovedOut = false, today = jstToday() } = {}) {
  const map = new Map()
  for (const t of tenants) {
    const movedOut = isMovedOut(t, today)
    if (movedOut && !includeMovedOut) continue
    const key = t.floor || ''
    if (!map.has(key)) map.set(key, [])
    map.get(key).push({ tenant: t, movedOut, movingOut: isMovingOut(t, today) })
  }
  return [...map.entries()]
    .sort(([a], [b]) => floorRank(a) - floorRank(b) || a.localeCompare(b))
    .map(([floor, rows]) => ({
      floor,
      rows: rows.sort((a, b) => Number(a.movedOut) - Number(b.movedOut) || byCode(a.tenant, b.tenant)),
    }))
}

export function formatDate(iso) {
  return iso ? iso.replaceAll('-', '/') : ''
}
