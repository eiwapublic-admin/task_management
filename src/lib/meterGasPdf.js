// 検針: ガス・水道お渡し票（メータ検針報告書）の PDF（Phase 4。2026-11-10〜。docs/meter-plan.md 5章）。
// FileMaker の「ガス・水道お渡し票」と同じく、A4 縦1枚の上半分を「テナント様用」、下半分を「（控）」にして、
// ガス・水道のメータを持つテナントごとに1枚作る（いまは さくら 様の1枚）。
// 値は検針一覧と同じ buildMonthRows（今月の検針値・今月の使用量・前月の使用量）。月の半ばのガス・水道の検針は翌月度に入る。
// 作りはテナント一覧表の PDF（tenantListPdf.js）と同じ: 見えない iframe に描いて html2canvas＋jsPDF

import { buildMonthRows } from './meterMonth'
import { BILMEN_BUILDING_NAME } from './bilmen'
import { escapeXml as esc } from './xlsxWrite'

export const GAS_WATER_KINDS = ['ガス', '水道']
const STYLE_URL = '/print/meter-gas.css'
const OFFICE = `${BILMEN_BUILDING_NAME}　管理事務所`

// '2026-10-16' → '2026年10月16日'
export function jaDate(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return `${y}年${m}月${d}日`
}

// 検針値・使用量は小数第1位まで（FileMaker のお渡し票と同じ）
export function gasValue(n) {
  if (n == null || n === '') return ''
  const v = Number(n)
  if (!Number.isFinite(v)) return ''
  return v.toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/**
 * お渡し票に載せるテナントと行（ガス→水道の順）
 * @param {{ month, tenants, meters, readings, photos }} data fetchMeterMonth の結果
 * @returns {{ tenant, readOn: string, rows: { kind, meterNo, value, usage, prevUsage, entered }[] }[]}
 */
export function buildGasSlips(data) {
  const rows = buildMonthRows({ ...data, photos: data.photos || [] }).filter((r) => GAS_WATER_KINDS.includes(r.meter.kind))
  const byTenant = new Map()
  for (const r of rows) {
    const key = r.tenant?.id || `meter:${r.meter.id}`
    const g = byTenant.get(key) || { tenant: r.tenant, readOn: '', rows: [] }
    if (r.reading?.read_on && r.reading.read_on > g.readOn) g.readOn = r.reading.read_on
    g.rows.push({
      kind: r.meter.kind,
      meterNo: r.meter.meter_no,
      value: r.entered ? r.reading.value : null,
      usage: r.entered ? r.total : null,
      prevUsage: r.prevTotal,
      entered: r.entered,
    })
    byTenant.set(key, g)
  }
  for (const g of byTenant.values()) {
    g.rows.sort((a, b) => GAS_WATER_KINDS.indexOf(a.kind) - GAS_WATER_KINDS.indexOf(b.kind) || a.meterNo.localeCompare(b.meterNo))
  }
  return [...byTenant.values()]
}

export function tenantLabel(tenant) {
  return tenant?.short_name || tenant?.name || ''
}

const num = (v) => (v == null ? '' : `${esc(gasValue(v))}<span class="unit">㎥</span>`)

function slipHtml(slip, copyLabel) {
  // 同じ種類のメータが2つ以上あるときだけメータ番号を添える
  const dup = (kind) => slip.rows.filter((r) => r.kind === kind).length > 1
  const rows = slip.rows.map(
    (r) =>
      `<tr><td class="kind">${esc(r.kind)}${dup(r.kind) ? `<br><small>${esc(r.meterNo)}</small>` : ''}</td><td class="num">${num(r.value)}</td><td class="num">${num(r.usage)}</td><td class="num">${num(r.prevUsage)}</td></tr>`
  )
  // FileMaker の票と同じく、行が少ないときは空の行で3行にそろえる
  while (rows.length < 3) rows.push('<tr><td class="kind"></td><td></td><td></td><td></td></tr>')
  return `<section class="slip"><div class="copy">${esc(copyLabel)}</div>
<h1>メータ検針報告書</h1>
<div class="to"><div class="name">${esc(tenantLabel(slip.tenant))}　様</div><div class="date">検針日付　${esc(jaDate(slip.readOn))}</div></div>
<table><thead><tr><th class="kind"></th><th>今月の検針値</th><th>今月の使用量</th><th>前月の使用量</th></tr></thead><tbody>${rows.join('')}</tbody></table>
<div class="office">${esc(OFFICE)}</div></section>`
}

export function gasPdfTitle(month) {
  const [y, m] = month.split('-')
  return `ガス・水道お渡し票_${y}年${Number(m)}月度`
}

/** 印刷用の HTML（テナントごとに A4 縦1枚。上がテナント様用、下が控） */
export function buildGasSlipHtml(month, slips, { styleHref = STYLE_URL } = {}) {
  const title = gasPdfTitle(month)
  const pages = slips.map((s) => `<div class="page">${slipHtml(s, 'テナント様用')}${slipHtml(s, '（控）')}</div>`).join('')
  return {
    title,
    html: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="${esc(styleHref)}"></head><body>${pages}</body></html>`,
  }
}

/**
 * お渡し票の PDF を作る。戻り値: { blob, filename, pages }
 * @param {string} month 検針月度
 * @param {ReturnType<typeof buildGasSlips>} slips
 */
export async function buildGasSlipPdfFile(month, slips) {
  if (!slips.length) throw new Error('ガス・水道のメータがありません')
  const styleHref = new URL(STYLE_URL, window.location.origin).href
  const { title, html } = buildGasSlipHtml(month, slips, { styleHref })
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;'
  document.body.appendChild(frame)
  try {
    const doc = frame.contentDocument
    doc.open()
    doc.write(html)
    doc.close()
    const link = doc.querySelector('link[rel="stylesheet"]')
    if (!link.sheet) {
      const ok = await new Promise((resolve) => {
        link.addEventListener('load', () => resolve(true), { once: true })
        link.addEventListener('error', () => resolve(false), { once: true })
        setTimeout(() => resolve(!!link.sheet), 10000)
      })
      if (!ok) throw new Error('印刷用の書式を読み込めませんでした。画面を再読み込みしてからもう一度お試しください')
    }
    await (doc.fonts?.ready ?? Promise.resolve())
    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')])
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
    const pages = [...doc.querySelectorAll('.page')]
    for (let i = 0; i < pages.length; i++) {
      const canvas = await html2canvas(pages[i], { scale: 2.5, backgroundColor: '#ffffff', windowWidth: pages[i].scrollWidth })
      if (i > 0) pdf.addPage('a4', 'portrait')
      // 圧縮指定（'FAST'）が無いと画像が生のまま入り数十MBになる（他の帳票と同じ）
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 210, 297, undefined, 'FAST')
    }
    pdf.setProperties({ title })
    return { blob: pdf.output('blob'), filename: `${title}.pdf`, pages: pages.length }
  } finally {
    frame.remove()
  }
}
