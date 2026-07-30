// タスクのステータス定義。表示順・識別色を一元管理する。
// 仕様書の遷移フロー: 未処理 → 返信済み / 対応中 → 完了

export const STATUS_LIST = ['未処理', '返信済み', '対応中', '完了']

// 対応が済んでいるステータス。期限の警告表示など「まだ対応が必要」な演出を
// 抑える判定に使う（完了タスクの期限超過を赤く目立たせても意味がないため）。
export const STATUS_DONE = '完了'

// 担当者を特定できないタスクに設定するプレースホルダー。
// この値のタスクは画面上でオレンジの警告表示にする。
export const UNASSIGNED = '（担当未設定）'

export const STATUS_META = {
  未処理: { color: 'var(--status-todo)', description: '新規に登録された未対応のタスク' },
  返信済み: { color: 'var(--status-replied)', description: '共有アドレスから返信済み' },
  対応中: { color: 'var(--status-progress)', description: '担当者が対応中' },
  完了: { color: 'var(--status-done)', description: '対応が完了したタスク' },
}
