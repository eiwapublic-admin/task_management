// public/sw.js を生成する。ビルドのたびに実行し、バージョンを刻印する。
//
// 設計方針（重要）:
//  - この SW は fetch イベントを一切持たない。したがってナビゲーションを横取りせず、
//    React Router のクライアント遷移を壊さない（Cloudflare Workers の静的配信でも安全）。
//  - 役割は「更新の検知」と「SKIP_WAITING による有効化」だけ。オフラインキャッシュは行わない。
//  - SW_VERSION がデプロイごとに変わることで、ブラウザが新版を検知し ReloadPrompt がバナーを出す。
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(__dirname, '../public/sw.js')

// デプロイごとに一意になるバージョン。git SHA を優先し、無ければビルド時刻。
let version
try {
  version = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
} catch {
  version = String(Date.now())
}
if (!version) version = String(Date.now())

const sw = `/*
 * 最小 Service Worker（自動生成 / scripts/generate-sw.mjs）
 * -----------------------------------------------------------
 * fetch ハンドラを持たない = リクエストを一切横取りしない。
 * よってナビゲーションを壊さず、更新検知と SKIP_WAITING のみを担う。
 */
const SW_VERSION = ${JSON.stringify(version)}

self.addEventListener('install', () => {
  // ここでは skipWaiting しない。新版は waiting のまま留まり、ユーザーが
  // 更新バナー（またはロゴタップ）で明示的に有効化する。
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 旧 PWA が残したキャッシュを掃除する。この SW はキャッシュを使わない。
      try {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      } catch (e) {
        /* 失敗しても続行 */
      }
      // 有効化後すぐ現在のクライアントを制御下に置く。
      await self.clients.claim()
    })()
  )
})

self.addEventListener('message', (event) => {
  // 更新バナー/ロゴタップからの要求で待機中の新版を有効化する。
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
`

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, sw)
console.log(`[generate-sw] public/sw.js written (version=${version})`)
