// テナント一覧表・緊急連絡先一覧表の印刷用 PDF（2026-10-21〜。デザインは依頼元が選んだ「案C ティール＋数字カード」）。
// 画面の中に見えない iframe を作って表を描き、ブラウザの印刷を開く（印刷先で「PDFに保存」を選ぶ。PDF のライブラリや
// 日本語フォントを読み込まずに済み、追加の費用もかからない）。どちらも A4 横1枚に収まるよう、表の大きさを縮めて合わせる。
// 行（入居中のテナント・階の順・部屋番号）は Excel 出力と同じ buildTenantListGroups で作る。
// テナント一覧表は出力前に聞く時点の日付で退去済みのテナントを、どちらも警備番号が空のテナントを除く（2026-10-26〜）。
// 緊急連絡先一覧表の「更新情報」は、指定した日以降のテナントマスタの変更履歴（変更理由があればそれ、無ければ変わった項目名）

import { TENANT_FIELD_LABELS, TENANT_PROFILE_LABELS, fetchMeterHistory, fetchMeterMasters } from './meter'
import { isMovedOut, jstToday } from './tenants'
import { buildTenantListGroups } from './tenantListExport'
import { escapeXml as esc } from './xlsxWrite'

export const TENANT_PDF_KINDS = {
  tenants: { label: 'テナント一覧表' },
  emergency: { label: '緊急連絡先一覧表' },
}

// 変更履歴のうち、更新情報に載せない項目（記録用の列と、一覧表の作成用のメモ）
const SKIP_FIELDS = new Set(['updated_at', 'created_at', 'updated_by', 'synced_at', 'legacy_id'])
const SKIP_PROFILE = new Set(['update_info', 'fix_note', 'list_exclude', 'entry_date'])

const slash = (d) => (d ? String(d).replaceAll('-', '/') : '')
const dash = (s) => (s == null || s === '' || s === '-' ? '' : String(s))
const jstDate = (iso) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const floorName = (f) => (f === 'B' ? 'B1F' : `${f}F`)

// 1件の変更履歴を「2026/10/21 変更理由」または「2026/10/21 火元責任者・緊急連絡先を変更」の1行にする（載せるものが無ければ null）
export function historyLine(h) {
  const date = slash(jstDate(h.changed_at))
  if (h.reason) return `${date} ${h.reason}`
  if (h.op === 'insert') return `${date} 新規登録`
  if (h.op === 'delete') return `${date} 削除`
  const labels = []
  for (const f of h.changed_fields || []) {
    if (SKIP_FIELDS.has(f)) continue
    if (f !== 'profile') {
      labels.push(TENANT_FIELD_LABELS[f] || f)
      continue
    }
    const o = h.old_row?.profile || {}
    const n = h.new_row?.profile || {}
    for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
      if (SKIP_PROFILE.has(k) || JSON.stringify(o[k] ?? null) === JSON.stringify(n[k] ?? null)) continue
      labels.push(TENANT_PROFILE_LABELS[k] || k)
    }
  }
  return labels.length ? `${date} ${[...new Set(labels)].join('・')}を変更` : null
}

const mails = (t) => (t.notice_emails?.length ? t.notice_emails : t.profile?.email ? [t.profile.email] : [])

function contactCell(c = {}) {
  const name = dash(c.name)
  const tels = [dash(c.mobile), dash(c.phone)].filter(Boolean)
  if (!name && !tels.length) return ''
  return `<b>${esc(name)}</b><span class="tel">${tels.map(esc).join(' ／ ')}</span>`
}

// 列: [見出し, 行 → HTML, class]
const COLUMNS = {
  tenants: [
    ['部屋', (r) => esc(r.room), 'c nw'],
    ['テナント名', (r) => esc(r.tenant.name), 'name'],
    ['警備', (r) => esc(r.p.security_block ?? ''), 'c nw'],
    ['代表電話', (r) => esc(r.p.phone ?? ''), 'nw'],
    ['メールアドレス', (r) => mails(r.tenant).map(esc).join('<br>'), 'mail'],
    ['用途', (r) => esc(r.p.usage ?? ''), 'c nw'],
    ['代表者', (r) => esc(r.p.representative ?? ''), 'nw'],
    ['面積㎡', (r) => (r.area ? r.area.toFixed(2) : ''), 'r nw'],
    ['人数', (r) => esc(r.p.capacity ?? ''), 'r nw'],
    [
      '火元責任者',
      (r) => `${r.p.fire_manager_title ? `<span class="sub">${esc(r.p.fire_manager_title)}</span> ` : ''}${esc(r.p.fire_manager ?? '')}`,
      'nw',
    ],
    ['選任日', (r) => slash(r.p.fire_manager_appointed_on), 'c nw'],
    ['プレート表示', (r) => esc(r.p.plate_name || r.p.fire_manager || ''), 'nw'],
  ],
  emergency: [
    ['部屋', (r) => esc(r.room), 'c nw'],
    ['テナント名', (r) => esc(r.tenant.name), 'name'],
    ['警備', (r) => esc(r.p.security_block ?? ''), 'c nw'],
    ['会社電話', (r) => esc(r.p.company_phone || r.p.phone || ''), 'nw'],
    ['緊急連絡先 1', (r) => contactCell(r.p.emergency_contacts?.[0]), 'contact'],
    ['緊急連絡先 2', (r) => contactCell(r.p.emergency_contacts?.[1]), 'contact'],
    ['緊急連絡先 3', (r) => contactCell(r.p.emergency_contacts?.[2]), 'contact'],
    ['記入日', (r) => slash(r.p.entry_date), 'c nw'],
    ['更新情報', (r) => r.updates.map(esc).join('<br>'), 'upd'],
  ],
}

// 書式は public/print/tenant-list.css。アプリの CSP（style-src 'self'）では iframe に埋め込んだ <style> が無視されるため、
// 同じオリジンのファイルとして読み込む（2026-10-21。埋め込みにしていたら本番で書式が全く効かなかった）
const STYLE_URL = '/print/tenant-list.css'

function sheetHtml(kind, groups, { since, asOf, today }) {
  const label = TENANT_PDF_KINDS[kind].label
  const cols = COLUMNS[kind]
  const rows = groups.flatMap((g) => g.rows)
  const kpis =
    kind === 'tenants'
      ? [
          [rows.length, 'テナント'],
          [rows.reduce((s, r) => s + (Number(r.p.capacity) || 0), 0), '従業員'],
          [slash(today), '作成日'],
        ]
      : [
          [rows.length, 'テナント'],
          [rows.filter((r) => r.updates.length).length, `更新あり（${slash(since)}〜）`],
          [slash(today), '作成日'],
        ]
  let body = ''
  for (const g of groups) {
    g.rows.forEach((r, i) => {
      const floor = i === 0 ? `<td class="floor" rowspan="${g.rows.length}">${floorName(g.floor)}</td>` : ''
      const cells = cols.map(([, fn, cls]) => `<td class="${cls}">${fn(r) ?? ''}</td>`).join('')
      const cls = [i === g.rows.length - 1 ? 'last' : '', r.movedOut ? 'moved-out' : ''].filter(Boolean).join(' ')
      body += `<tr class="${cls}">${floor}${cells}</tr>`
    })
  }
  const head = `<tr><th class="c">階</th>${cols.map(([h, , cls]) => `<th class="${cls}">${esc(h)}</th>`).join('')}</tr>`
  const note =
    kind === 'emergency'
      ? `更新情報は ${slash(since)} 以降のテナントマスタの変更（${slash(since)} 時点で退去日を迎えていないテナントを含む）　／　`
      : `${slash(asOf)} 時点で入居中のテナント　／　`
  return `<div class="page"><div class="fit">
<header><h1>${esc(label)}</h1><div class="kpis">${kpis.map(([v, l]) => `<div><b>${esc(v)}</b>${esc(l)}</div>`).join('')}</div></header>
<table><thead>${head}</thead><tbody>${body}</tbody></table>
<footer>${note}${esc(label)}　${slash(today)} 作成</footer>
</div></div>`
}

// 表を A4 横1枚に収める。縮めるときは表の幅を広げてから縮めるので、縮めても横幅は用紙いっぱいのまま
export function fitToPage(doc) {
  const page = doc.querySelector('.page')
  const fit = doc.querySelector('.fit')
  const cs = doc.defaultView.getComputedStyle(page)
  const w = page.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  const h = page.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
  let scale = 1
  for (let i = 0; i < 6; i++) {
    fit.style.width = `${w / scale}px`
    const next = Math.min(1, h / fit.scrollHeight)
    if (Math.abs(next - scale) < 0.002) break
    scale = next
  }
  fit.style.width = `${w / scale}px`
  scale = Math.min(scale, h / fit.scrollHeight) * 0.995
  fit.style.width = `${w / scale}px`
  fit.style.transform = `scale(${scale})`
  return scale
}

/** 印刷用の HTML を作る（kind: 'tenants' | 'emergency'。since は緊急連絡先一覧表の更新情報の起点 YYYY-MM-DD） */
// asOf はテナント一覧表の時点の日付（その日に退去済みのテナントを除く。2026-10-26〜）
export function buildTenantListPdfHtml(kind, { tenants, meters, history = [], since = '', asOf = '', today = jstToday(), styleHref = STYLE_URL }) {
  const updatesByTenant = new Map()
  for (const h of [...history].sort((a, b) => String(a.changed_at).localeCompare(String(b.changed_at)))) {
    if (h.table_name && h.table_name !== 'equipment_tenants') continue
    const line = historyLine(h)
    if (!line) continue
    if (!updatesByTenant.has(h.row_key)) updatesByTenant.set(h.row_key, [])
    updatesByTenant.get(h.row_key).push(line)
  }
  // 緊急連絡先一覧表は、起点の日付の時点で退去日を迎えていないテナント（その後に退去した・退去予定）も載せ、
  // 更新情報の先頭に退去日を出す（2026-10-26 依頼）
  const emergency = kind === 'emergency'
  const groups = buildTenantListGroups(tenants, meters, today, { activeOn: emergency ? since : asOf }).map((g) => ({
    ...g,
    rows: g.rows.map((r) => {
      const t = r.tenant
      const moveOut =
        emergency && t.moved_out_on && (!since || t.moved_out_on > since)
          ? [`${slash(t.moved_out_on)} ${isMovedOut(t, today) ? '退去' : '退去予定'}`]
          : []
      return { ...r, p: t.profile || {}, movedOut: isMovedOut(t, today), updates: [...moveOut, ...(updatesByTenant.get(t.id) || [])] }
    }),
  }))
  const title = `${TENANT_PDF_KINDS[kind].label}_${today.replaceAll('-', '')}`
  return {
    title,
    html: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="${esc(styleHref)}"></head><body>${sheetHtml(kind, groups, { since, asOf: asOf || today, today })}</body></html>`,
  }
}

// テナント一覧表の時点の既定: 今月の1日（2026-10-26 依頼）
export function defaultAsOf(today = jstToday()) {
  return `${today.slice(0, 7)}-01`
}

// 既定の起点: 前の月の1日
export function defaultUpdateSince(today = jstToday()) {
  const [y, m] = today.split('-').map(Number)
  const t = y * 12 + (m - 1) - 1
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`
}

// '2026/10/1'・'2026-10-01'・'20261001' → '2026-10-01'（読めなければ null）
export function parseSinceDate(s) {
  const m = String(s || '')
    .normalize('NFKC')
    .trim()
    .match(/^(\d{4})[-/.年]?(\d{1,2})[-/.月]?(\d{1,2})日?$/)
  if (!m) return null
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  const d = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso
}

/** 出力する。見えない iframe に描いてブラウザの印刷を開く（「PDFに保存」で PDF になる）。載せた件数を返す */
export async function printTenantListPdf(kind, { since = '', asOf = '' } = {}) {
  if (!TENANT_PDF_KINDS[kind]) throw new Error('出力の種類が正しくありません')
  const [data, history] = await Promise.all([
    fetchMeterMasters(),
    kind === 'emergency' ? fetchMeterHistory({ table: 'equipment_tenants', since, limit: 2000 }) : [],
  ])
  // iframe（about:blank）の中では相対パスが解決されないことがあるので、絶対 URL で渡す
  const styleHref = new URL(STYLE_URL, window.location.origin).href
  const { title, html } = buildTenantListPdfHtml(kind, {
    tenants: data.tenants || [],
    meters: data.meters || [],
    history,
    since,
    asOf,
    styleHref,
  })

  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  // 印刷の計算が正しくなるよう、用紙と同じ大きさで画面の外に置く
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:297mm;height:210mm;border:0;'
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  doc.open()
  doc.write(html)
  doc.close()
  // 書式のファイルを読み終えてから大きさを合わせる（読み込めなければ崩れた表を印刷しないよう止める）
  const link = doc.querySelector('link[rel="stylesheet"]')
  if (!link.sheet) {
    const ok = await new Promise((resolve) => {
      link.addEventListener('load', () => resolve(true), { once: true })
      link.addEventListener('error', () => resolve(false), { once: true })
      setTimeout(() => resolve(!!link.sheet), 10000)
    })
    if (!ok) {
      frame.remove()
      throw new Error('印刷用の書式を読み込めませんでした。画面を再読み込みしてからもう一度お試しください')
    }
  }
  await (doc.fonts?.ready ?? Promise.resolve())
  fitToPage(doc)

  // PDF のファイル名は親の画面のタイトルになるブラウザが多いので、印刷の間だけ差し替える
  const prevTitle = document.title
  document.title = title
  const cleanup = () => {
    document.title = prevTitle
    frame.remove()
  }
  frame.contentWindow.addEventListener('afterprint', () => setTimeout(cleanup, 500), { once: true })
  frame.contentWindow.focus()
  frame.contentWindow.print()
  // afterprint が来ないブラウザ向けの保険
  setTimeout(() => frame.isConnected && cleanup(), 120000)
  return doc.querySelectorAll('tbody tr').length
}
