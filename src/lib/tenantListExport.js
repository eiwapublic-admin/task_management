// テナント一覧表・緊急連絡先一覧表の Excel 出力（2026-10-21〜）。
// 元は手作業の「火元責任者・緊急連絡先一覧表.xlsx」の「最新」シート。1枚の表の左半分（F〜P列）がテナント一覧表、
// 右半分（R〜AC列）が緊急連絡先一覧（セコム提出用）で、列のグループの片方を隠して使い分けていた。
// ここでも同じ1枚の表を作り、緊急連絡先の列グループ（R〜AC）を隠した状態で出す（グループの「＋」で開けば緊急連絡先一覧表になる。
// 2026-10-21 の依頼で出力は「テナント一覧表」の1ファイルに整理。雛形は public/templates/tenant-list.xlsx。
// 元の「最新」シートから見出し4行と、データ行・階の区切り行・合計行の書式見本を残したもの）。
// 行はテナントマスタの入居中のテナント（退去日を過ぎたもの・「一覧表に載せない」・階の無いものを除く）を、
// 7F → 1F → B1 の順、各階の中は部屋番号の順に並べる

import { fetchMeterMasters } from './meter'
import { isMovedOut, jstToday } from './tenants'
import { cellXml, colName, downloadBlob, unzipXlsx, zipFiles } from './xlsxWrite'

export const TENANT_LIST_KINDS = {
  tenants: { label: 'テナント一覧表' },
}
// 隠すほうの列グループ（緊急連絡先の R〜AC）
const OTHER_GROUP = { tenants: [18, 29] }

const FIRST_ROW = 5 // 雛形の見出しは4行
const COLS = 29 // A〜AC

// 階の並び（上の階から。B は地下1階）
const FLOOR_ORDER = ['7', '6', '5', '4', '3', '2', '1', 'B']
const floorLabel = (f) => (f === 'B' ? 'B１' : Number.isNaN(Number(f)) ? f : Number(f))

const natural = (a, b) => String(a).localeCompare(String(b), 'ja', { numeric: true })

// メータがテナントの階にあるか。部屋番号が 0 で始まるもの（03-A など）は地下1階の倉庫なので、地下のテナント以外では除く
const onTenantFloor = (tenant, m) => (m.floor || '') === (tenant.floor || '') && (tenant.floor === 'B' || !/^0/.test(m.room_no || ''))

// 部屋番号: 入力があればそれ、無ければ旧テナントコード（FileMaker。21_23 → 21-23）、無ければ同じ階のメータの部屋番号
function roomLabel(tenant, meters) {
  const p = tenant.profile || {}
  if (p.room_label) return p.room_label
  if (p.legacy_tenant_code) return p.legacy_tenant_code.replace(/_/g, '-').replace(/^B(?=\d)/, '')
  const rooms = [...new Set(meters.filter((m) => !m.removed && m.room_no && onTenantFloor(tenant, m)).map((m) => m.room_no))]
  return rooms.sort(natural).join('・')
}

// 占有面積（㎡）: 同じ階にあるそのテナントのメータの部屋面積の合計（無ければ空）
function occupiedArea(tenant, meters) {
  const areas = meters.filter((m) => !m.removed && onTenantFloor(tenant, m) && Number(m.area_m2) > 0)
  if (!areas.length) return null
  return Math.round(areas.reduce((s, m) => s + Number(m.area_m2), 0) * 100) / 100
}

const asNumberIfDigits = (v) => (v != null && /^\d+$/.test(String(v)) ? Number(v) : v || null)

/**
 * テナントマスタから表の行（階ごと）を作る。画面のテストでも使う。
 * activeOn（YYYY-MM-DD。任意）: その日の時点で退去日を迎えていないテナントも載せる
 * （緊急連絡先一覧表で、起点の日付より後に退去した〈退去する〉テナントも残すため。2026-10-26 依頼）
 */
export function buildTenantListGroups(tenants, meters, today = jstToday(), { activeOn = '' } = {}) {
  const listed = (t) =>
    !isMovedOut(t, today) || (!!activeOn && activeOn < today && !!t.moved_out_on && t.moved_out_on > activeOn)
  const metersByTenant = new Map()
  for (const m of meters) {
    if (!m.tenant_id) continue
    if (!metersByTenant.has(m.tenant_id)) metersByTenant.set(m.tenant_id, [])
    metersByTenant.get(m.tenant_id).push(m)
  }
  const groups = []
  for (const floor of FLOOR_ORDER) {
    const rows = tenants
      .filter((t) => (t.floor || '') === floor && listed(t) && !t.profile?.list_exclude)
      .map((t) => {
        const own = metersByTenant.get(t.id) || []
        return { tenant: t, room: roomLabel(t, own), area: occupiedArea(t, own) }
      })
      .sort((a, b) => natural(a.room, b.room) || natural(a.tenant.billing_code || '', b.tenant.billing_code || ''))
    if (rows.length) groups.push({ floor, rows })
  }
  return groups
}

// 1行のセルの値（列番号 → 値）
function rowValues({ tenant: t, room, area }) {
  const p = t.profile || {}
  const contacts = p.emergency_contacts || []
  const mail = (t.notice_emails?.length ? t.notice_emails : p.email ? [p.email] : []).join(',\n')
  const v = {
    1: asNumberIfDigits(t.billing_code),
    3: t.name,
    4: room,
    5: asNumberIfDigits(p.security_block),
    6: p.phone,
    7: mail,
    8: p.usage,
    9: p.representative,
    10: area,
    11: p.capacity ?? null,
    12: p.fire_manager_title,
    13: p.fire_manager,
    14: p.fire_manager_appointed_on ? { date: p.fire_manager_appointed_on } : null,
    15: p.plate_name || p.fire_manager,
    16: p.fire_manager_note,
    18: p.company_phone || p.phone,
    28: p.entry_date ? { date: p.entry_date } : null,
    29: p.update_info,
  }
  for (let i = 0; i < 3; i++) {
    const c = contacts[i] || {}
    v[19 + i * 3] = c.name
    v[20 + i * 3] = c.phone
    v[21 + i * 3] = c.mobile
  }
  return v
}

// 雛形の行（<row r="n">）から、列ごとの書式番号と行の高さを取り出す
function rowTemplate(sheetXml, r) {
  const m = sheetXml.match(new RegExp(`<row r="${r}"([^>]*)>(.*?)</row>`, 's'))
  const styles = {}
  if (!m) return { attrs: '', styles }
  for (const c of m[2].matchAll(/<c r="([A-Z]+)\d+"(?: s="(\d+)")?/g)) styles[c[1]] = c[2] ?? null
  return { attrs: m[1].replace(/\s*spans="[^"]*"/, ''), styles }
}

function rowXml(r, tpl, values = {}) {
  const cells = []
  for (let c = 1; c <= COLS; c++) {
    const col = colName(c)
    const style = tpl.styles[col]
    const value = values[c]
    if (style == null && (value == null || value === '')) continue
    cells.push(cellXml(`${col}${r}`, style, value))
  }
  return `<row r="${r}"${tpl.attrs}>${cells.join('')}</row>`
}

/** 出力する（kind: 'tenants'）。ファイルを保存させ、出力した件数を返す */
export async function exportTenantList(kind) {
  const def = TENANT_LIST_KINDS[kind]
  if (!def) throw new Error('出力の種類が正しくありません')
  const [data, tplRes] = await Promise.all([fetchMeterMasters(), fetch('/templates/tenant-list.xlsx')])
  if (!tplRes.ok) throw new Error('Excel の雛形を読み込めませんでした')
  const files = await unzipXlsx(await tplRes.arrayBuffer())
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  let sheet = dec.decode(files.get('xl/worksheets/sheet1.xml'))
  let book = dec.decode(files.get('xl/workbook.xml'))

  const groups = buildTenantListGroups(data.tenants || [], data.meters || [])
  const dataTpl = rowTemplate(sheet, 5)
  const gapTpl = rowTemplate(sheet, 6)
  const footTpl = rowTemplate(sheet, 7)
  const headRows = [...sheet.matchAll(/<row r="[1-4]"[^>]*>.*?<\/row>/gs)].map((m) => m[0])

  const rows = []
  const merges = []
  let r = FIRST_ROW
  let count = 0
  let staff = 0
  groups.forEach((g, gi) => {
    const start = r
    g.rows.forEach((row, i) => {
      const values = rowValues(row)
      if (i === 0) values[2] = floorLabel(g.floor)
      rows.push(rowXml(r, dataTpl, values))
      count++
      staff += Number(row.tenant.profile?.capacity) || 0
      r++
    })
    if (r - 1 > start) merges.push(`B${start}:B${r - 1}`)
    if (gi < groups.length - 1) rows.push(rowXml(r++, gapTpl))
  })
  const lastData = Math.max(r - 1, FIRST_ROW)
  rows.push(rowXml(r, footTpl, { 8: 'テナント数：', 9: count, 10: '従業員数：', 11: staff }))
  const lastRow = r

  // 見出しの「最新の選任日」「最新の記入日」の式を、データの範囲に合わせる（日付が1件も無ければ空にする。0 が 1899/12/30 と出るため）
  const all = groups.flatMap((g) => g.rows)
  const hasAppointed = all.some((x) => x.tenant.profile?.fire_manager_appointed_on)
  const hasEntry = all.some((x) => x.tenant.profile?.entry_date)
  const head = headRows
    .join('')
    .replace(/<f>MAX\(N5:N\d+\)<\/f>(<v><\/v>)?/, hasAppointed ? `<f>MAX(N${FIRST_ROW}:N${lastData})</f>` : '')
    .replace(/<f>MAX\(AB5:AB\d+\)<\/f>(<v><\/v>)?/, hasEntry ? `<f>MAX(AB${FIRST_ROW}:AB${lastData})</f>` : '')
  sheet = sheet.replace(/<sheetData>.*<\/sheetData>/s, `<sheetData>${head}${rows.join('')}</sheetData>`)
  sheet = sheet.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:AC${lastRow}"/>`)
  sheet = sheet.replace(/<mergeCells count="\d+">(.*?)<\/mergeCells>/s, (_, inner) => {
    const all = inner + merges.map((m) => `<mergeCell ref="${m}"/>`).join('')
    return `<mergeCells count="${(all.match(/<mergeCell /g) || []).length}">${all}</mergeCells>`
  })
  sheet = sheet.replace(/<brk id="17" min="0" max="\d+"/, `<brk id="17" min="0" max="${lastRow}"`)
  // 使わないほうの列グループを隠す（Excel の列のグループの「－」を押したのと同じ状態）
  const [h1, h2] = OTHER_GROUP[kind]
  sheet = sheet.replace(/<col ([^>]*?)min="(\d+)" max="(\d+)"\/>/g, (all, attrs, min, max) => {
    const lo = Number(min)
    if (lo >= h1 && Number(max) <= h2) return `<col ${attrs}hidden="1" min="${min}" max="${max}"/>`
    if (lo === h2 + 1) return `<col ${attrs}collapsed="1" min="${min}" max="${max}"/>`
    return all
  })
  sheet = sheet.replace(/<sheetFormatPr ([^>]*?)\/>/, (all, attrs) =>
    attrs.includes('outlineLevelCol') ? all : `<sheetFormatPr ${attrs} outlineLevelCol="1"/>`,
  )
  book = book.replace(/(_xlnm\.Print_Area"[^>]*>[^<]*\$AC\$)\d+/, `$1${lastRow}`)

  files.set('xl/worksheets/sheet1.xml', enc.encode(sheet))
  files.set('xl/workbook.xml', enc.encode(book))
  const today = jstToday().replaceAll('-', '')
  downloadBlob(zipFiles(files), `${def.label}_${today}.xlsx`)
  return count
}
