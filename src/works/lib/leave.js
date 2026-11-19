// 休暇の日付の表示（申請書・申請の一覧で共通）
import { WEEKDAYS } from './api.js'

export const jpDate = (d) => {
  const [y, m, dd] = d.split('-').map(Number)
  return `${y}年${m}月${dd}日（${WEEKDAYS[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]}）`
}

// 連続する日をまとめる（[{from, to}]）
export function dateRanges(dates) {
  const out = []
  for (const d of [...dates].sort()) {
    const last = out[out.length - 1]
    if (last) {
      const next = new Date(`${last.to}T00:00:00Z`)
      next.setUTCDate(next.getUTCDate() + 1)
      if (next.toISOString().slice(0, 10) === d) {
        last.to = d
        continue
      }
    }
    out.push({ from: d, to: d })
  }
  return out
}

export function rangesLabel(dates) {
  return dateRanges(dates)
    .map((r) => (r.from === r.to ? jpDate(r.from) : `${jpDate(r.from)}〜${jpDate(r.to)}`))
    .join('、')
}
