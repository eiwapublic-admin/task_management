// Cloudflare Workers の「1回の呼び出しあたりの外部リクエスト数（サブリクエスト）」上限の管理。
// 2026-09-04 新設。
//
// 経緯: 9/3 の cron ログに `Too many subrequests by single Worker invocation` が連続して
// 出ており、1回の巡回で上限に達したあとの処理が軒並み失敗していた（HANDOFF 223番）。
//   - reply-check … 返信検知が失敗（返信がタスクに反映されない）
//   - calendar    … カレンダー登録が失敗
//   - archive     … 完了タスクの自動アーカイブが失敗
//   - usage       … **Claude利用量の記録が失敗** ＝ 従量課金事項の画面が実額より少なく出る
//   - 操作ログの書き込み自体も失敗し、異常が画面に一切残らなかった
//
// 上限に達してから個々のエラーを拾うのでは遅い（どの処理が犠牲になるかが運任せになる）。
// そこで「使った数を数えながら、残りが尽きる前に重い処理を打ち切る」方式にする。
// 末尾の記録処理（利用量・ログ・last_fetch_at 等）のぶんは常に取り置く。
//
// 数え方は概算で構わない。厳密に全ての fetch を数えるにはGmail/Supabaseの各ヘルパーを
// 全て包む必要があり、変更範囲が大きいわりに得るものが少ないため、pipeline.js 側の
// 主要な呼び出し地点だけを数え、取り置き（reserve）を厚めに取って吸収する。

// 無料プランの上限は50、有料（Workers Paid）は1000。
// 設定 `subrequest_limit` で上書きできる（プランを上げたときはこの値を増やす）。
export const DEFAULT_SUBREQUEST_LIMIT = 50

// 末尾の記録処理のために必ず残しておく数。
// 内訳の目安: 利用量RPC / 上限アラート解除 / クレジットアラート / アーカイブ /
// 操作ログのinsert / 古いログのdelete / processed_messagesのdelete / last_fetch_at更新
// ＋ 予備。
export const TAIL_RESERVE = 12

export function parseSubrequestLimit(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SUBREQUEST_LIMIT
  return n
}

// 使用数を数える小さなカウンタ。
//   use(n)  … n回ぶん使ったことにする
//   has(n)  … これから n 回使っても取り置きを侵さないか
export function createSubrequestBudget(limitRaw, reserve = TAIL_RESERVE) {
  const limit = parseSubrequestLimit(limitRaw)
  let used = 0
  return {
    limit,
    reserve,
    get used() {
      return used
    },
    get remaining() {
      return Math.max(limit - reserve - used, 0)
    },
    use(n = 1) {
      used += n
      return used
    },
    has(n = 1) {
      return used + n <= limit - reserve
    },
    snapshot() {
      return { used, limit, reserve }
    },
  }
}
