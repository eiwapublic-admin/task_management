// ビルド時刻（表示用バージョン）。vite.config.js の define で __BUILD_TIME__ に
// ビルド時の ISO 文字列が埋め込まれる。端末が最新デプロイを取得できているかを
// 画面上で一目で確認するための「人が読めるバージョン」。
// ※ 更新の「検知」は SW の SW_VERSION が担う。この表示値とは独立。

// typeof ガードにより、define 未適用の環境でも ReferenceError にならない
const raw = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : ''

// 'YYYY-MM-DD HH:MM'（Asia/Tokyo）に整形する。未定義なら 'dev'。
export function formatBuildTime() {
  if (!raw) return 'dev'
  try {
    // sv-SE ロケールは 'YYYY-MM-DD HH:MM:SS' 形式を返す
    const s = new Date(raw).toLocaleString('sv-SE', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    return s.replace(' ', ' ').slice(0, 16)
  } catch {
    return raw
  }
}
