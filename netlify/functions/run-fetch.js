import { runPipeline } from './lib/pipeline.js'
import { json, verifyRequestAuth } from './lib/http.js'

// 手動即時実行エンドポイント（/api/run-fetch）。
// ダッシュボードの「今すぐ取得」ボタンから呼ばれる。ログイン必須（JWT検証）。
// force=true で更新間隔ゲートを無視して即時に取得・分類する。
export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (!verifyRequestAuth(req)) {
    return json({ error: '認証が必要です' }, 401)
  }
  try {
    const summary = await runPipeline({ force: true })
    return json(summary)
  } catch (err) {
    console.error('run-fetch 失敗:', err)
    return json({ error: String(err.message || err) }, 500)
  }
}

export const config = {
  path: '/api/run-fetch',
}
