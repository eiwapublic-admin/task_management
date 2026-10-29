import { useCallback, useLayoutEffect, useRef } from 'react'

// 内容の分量に合わせて高さが自動で伸び縮みする textarea（2026-10-29〜。日報の作業記録で使用）。
// 既定は rows={1}（1行表示）。幅が変わったとき（画面回転・ウィンドウ幅の変更）も測り直す。
// 高さは CSSOM（el.style）で入れるので、本番 CSP（style-src 'self'）でも効く。
export default function AutoGrowTextarea({ value, rows = 1, onChange, ...rest }) {
  const ref = useRef(null)

  const fit = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const cs = getComputedStyle(el)
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
    el.style.height = `${el.scrollHeight + border}px`
  }, [])

  useLayoutEffect(() => {
    fit()
  }, [value, fit])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    let lastWidth = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return
      lastWidth = el.clientWidth
      fit()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit])

  return <textarea ref={ref} value={value} rows={rows} onChange={onChange} {...rest} />
}
