// テナントの部屋番号（2026-11-02〜）。画面（テナントマスタの一覧）・Worker（API の room_numbers）・
// テナント一覧表の Excel 出力で共通に使う。依存の無い純粋な関数だけを置く（Worker からも import する）。

const natural = (a, b) => String(a).localeCompare(String(b), 'ja', { numeric: true })

// メータがテナントの階にあるか。部屋番号が 0 で始まるもの（03-A など）は地下1階の倉庫なので、地下のテナント以外では除く
export const onTenantFloor = (tenant, m) =>
  (m.floor || '') === (tenant.floor || '') && (tenant.floor === 'B' || !/^0/.test(m.room_no || ''))

// 部屋番号の元の値: 一覧表用の入力（profile.room_label）があればそれ、無ければ旧テナントコード（FileMaker。21_23 → 21-23）、
// 無ければ同じ階のメータの部屋番号（重複を除いて番号順）。meters はそのテナントのメータ
export function tenantRoomParts(tenant, meters = []) {
  const p = tenant.profile || {}
  if (p.room_label) return [String(p.room_label)]
  if (p.legacy_tenant_code) return [String(p.legacy_tenant_code).replace(/_/g, '-').replace(/^B(?=\d)/, '')]
  const rooms = [...new Set(meters.filter((m) => !m.removed && m.room_no && onTenantFloor(tenant, m)).map((m) => m.room_no))]
  return rooms.sort(natural)
}

// 1つの値を部屋番号（数字。A・B などの枝番の英字は付けたまま）の並びにする。
// 「21-23」「21〜23」のような範囲は 21、22、23 に開く。「12-A」は 12A、「01-(1)」は 01、数字の無いもの（玄関など）は除く
function roomNumbersOf(value) {
  const out = []
  for (const raw of String(value).normalize('NFKC').split(/[・,、/\s]+/)) {
    const t = raw.replace(/号室|号/g, '').trim()
    if (!t) continue
    const range = t.match(/^(\d+)\s*[-~〜_]\s*(\d+)$/)
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])]
      if (b > a && b - a <= 20) {
        for (let n = a; n <= b; n++) out.push(String(n).padStart(range[1].length, '0'))
        continue
      }
    }
    const m = t.match(/^(\d+)(?:-?([A-Za-z])(?![A-Za-z]))?/)
    if (m) out.push(m[1] + (m[2] ? m[2].toUpperCase() : ''))
  }
  return out
}

// 一覧に出す部屋番号（数字だけ。複数は「、」区切り。2026-11-02 依頼）
export function tenantRoomNumbers(tenant, meters = []) {
  const list = [...new Set(tenantRoomParts(tenant, meters).flatMap(roomNumbersOf))]
  return list.sort(natural).join('、')
}
