import { useLayoutEffect, useRef } from 'react'

// 固定ヘッダーを複数層スタッキングするための補助フック。
//
// AppHeader は折り返し（狭幅）・safe-area-inset-top（ノッチ端末）で高さが
// 可変なため、その下に重ねる2段目・3段目のヘッダーの top オフセットを
// 固定値では合わせられない。要素の実際の高さを ResizeObserver で測り、
// document のCSS変数として反映することで、下の層は
// `top: calc(var(--app-header-h) + var(--sticky2-h, 0px))` のように
// 積み上げて指定できるようにする。
export default function useStickyHeightVar(varName) {
  const ref = useRef(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const root = document.documentElement
    const update = () => root.style.setProperty(varName, `${el.offsetHeight}px`)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.removeProperty(varName)
    }
  }, [varName])

  return ref
}
