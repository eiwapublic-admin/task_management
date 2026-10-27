// アプリ起動時のダッシュボード（ポータル）への振り替え（App.jsx の DefaultRoute）を
// 次の1回だけ止める印（2026-10-27）。「今すぐ取得」のあとの再読み込みはカンバンへ戻すのが目的なので、
// AppHeader がこの印を付けてから「/」を開き直す
const SKIP_LAUNCH_PORTAL_KEY = 'task_management_skip_launch_portal'

export function markSkipLaunchPortal() {
  try {
    sessionStorage.setItem(SKIP_LAUNCH_PORTAL_KEY, '1')
  } catch {
    // 保存できなくてもダッシュボードが開くだけなので無視する
  }
}

// 印があれば消して true を返す
export function takeSkipLaunchPortal() {
  try {
    const skip = sessionStorage.getItem(SKIP_LAUNCH_PORTAL_KEY) === '1'
    sessionStorage.removeItem(SKIP_LAUNCH_PORTAL_KEY)
    return skip
  } catch {
    return false
  }
}
