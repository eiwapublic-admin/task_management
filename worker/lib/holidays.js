// 日本の祝日一覧の取得（2026-08-05〜。自主検査表の日付列を祝日は赤字にするため）。
//
// 内閣府の祝日データをもとに公開されている静的JSON（holidays-jp/api）を使う。
// 認証不要・無料で、日付ごとの祝日名がすべて入っている（春分・秋分の日のように
// 年によって日付が変わる祝日も含め、天文計算を自前で持たずに済む）。
//
// ブラウザからの直接取得はCSP（connect-src 'self'）で禁止しているため、
// 必ずこの Worker 側で取得し、`/api/report/holidays` として自オリジンで配信する。
// Cloudflare のエッジキャッシュを使い、祝日データの更新頻度（年に数回）に対して
// 十分な間隔（1日）でしか外部へ取りに行かないようにする。

const HOLIDAYS_URL = 'https://holidays-jp.github.io/api/v1/date.json'

export async function fetchHolidays() {
  const res = await fetch(HOLIDAYS_URL, {
    cf: { cacheTtl: 86400, cacheEverything: true },
  })
  if (!res.ok) throw new Error(`祝日データの取得に失敗しました (${res.status})`)
  // { "2026-01-01": "元日", ... } という形式
  return res.json()
}
