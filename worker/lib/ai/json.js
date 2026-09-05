// AIの応答テキストからJSONを取り出す共通処理（提供元に依存しない）。
// 2026-09-05、worker/lib/anthropic.js から worker/lib/ai/ 配下へ移設した際に切り出した
// （提供元を切り替えられるようにするためのリファクタ。docs/ai-cost-and-alternatives.md 11章）。
// 中身は移設前と同一。

// 応答テキストから最初の JSON オブジェクトを頑健に取り出す。
export function extractJson(text) {
  if (!text) return null
  // ```json ... ``` で囲まれている場合を先に剥がす
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}
