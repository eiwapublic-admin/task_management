// reloadApp — ロゴタップなど任意のボタンから呼ぶ「アプリ最新化」処理。
//
// 単純な location.reload() だと、待機中の新しい Service Worker(SW) は有効化されず
// 古い版のままになる。そこでこの関数は:
//   1) 全 registration に update() を投げて新版の有無を確認
//   2) 待機中(waiting)の新 SW があれば SKIP_WAITING で有効化し、controllerchange を
//      待ってから 1 回だけリロード(来ない端末向けに保険タイマー)
//   3) まだ installing 中なら installed になるのを待ってから同様に有効化(1タップで確実に更新)
//   4) 新 SW が無ければそのままリロード
//
// 生成 SW(scripts/generate-sw.mjs)は message で SKIP_WAITING を受けて skipWaiting() する。

export async function reloadApp(options = {}) {
  const { fallbackMs = 3000 } = options
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.update().catch(() => {})))

      let reloaded = false
      const reloadOnce = () => {
        if (reloaded) return
        reloaded = true
        window.location.reload()
      }
      const activate = (sw) => {
        navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, {
          once: true,
        })
        window.setTimeout(reloadOnce, fallbackMs)
        sw.postMessage({ type: 'SKIP_WAITING' })
      }

      const waiting = regs.find((r) => r.waiting)?.waiting
      if (waiting) {
        activate(waiting)
        return
      }
      const installing = regs.find((r) => r.installing)?.installing
      if (installing) {
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed') activate(installing)
          else if (installing.state === 'redundant') reloadOnce()
        })
        window.setTimeout(reloadOnce, fallbackMs)
        return
      }
    }
  } catch {
    /* 失敗してもリロードは行う */
  }
  window.location.reload()
}
