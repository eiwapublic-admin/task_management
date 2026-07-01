import { runPipeline } from './lib/pipeline.js'

// Netlify Scheduled Function。
// 5分ごとに起動し、settings の fetch_interval_minutes を満たした場合のみ実際に取得する
// （実行間隔のゲートは runPipeline 内で判定）。
export default async () => {
  try {
    const summary = await runPipeline({ force: false })
    console.log('fetch-emails 完了:', JSON.stringify(summary))
    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('fetch-emails 失敗:', err)
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

export const config = {
  schedule: '*/5 * * * *',
}
