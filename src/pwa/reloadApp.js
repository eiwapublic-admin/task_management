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
// リロード後の遷移先は既定でトップページ(/)（2026-07-22。設定画面等どのページから
// タップしても、最新化後は必ずメイン画面に戻るようにするため）。
// 2026-08-12: ロゴタップの役割が「ダッシュボードへ移動」に変わり、最新化はダッシュボード
// 上でだけ行うようになったため、遷移先を to で指定できるようにした（ダッシュボードから
// 最新化したらダッシュボードへ戻る＝押した場所に戻る）。

export async function reloadApp(options = {}) {
  const { fallbackMs = 3000, to = '/' } = options
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.update().catch(() => {})))

      let reloaded = false
      const reloadOnce = () => {
        if (reloaded) return
        reloaded = true
        window.location.assign(to)
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
  window.location.assign(to)
}
