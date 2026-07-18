// タスクの情報源（メール/問い合わせフォーム/カレンダー/FAX/手入力）を判定し、
// カード・詳細画面のタイトル先頭に表示するアイコンを返す。
//
// tasks.channel が入っていればそれを使う（'email' / 'form' / 'fax' / 'calendar' / 'manual'）。
// channel 未設定の既存タスクは source から補完する（'calendar'→calendar、'manual'→manual、
// それ以外（'email'）→email。フォーム/FAXの区別までは既存タスクには無いため email 扱いになる）。
export function resolveChannel(task) {
  if (task.channel) return task.channel
  if (task.source === 'calendar') return 'calendar'
  if (task.source === 'manual') return 'manual'
  return 'email'
}

const CHANNEL_ICONS = {
  email: '📧',
  form: '🌐',
  calendar: '📅',
  fax: '📠',
  manual: '✏️',
}

// カード・詳細画面・アーカイブ一覧で使う情報源アイコン（画像）。public/icons 配下。
const CHANNEL_ICON_SRC = {
  email: '/icons/mail_icon.png',
  form: '/icons/globe_icon.png',
  calendar: '/icons/calendar_icon.png',
  fax: '/icons/fax_icon.png',
  manual: '/icons/pen_icon.png',
}

const CHANNEL_LABELS = {
  email: 'メール',
  form: 'お問い合わせフォーム',
  calendar: 'カレンダーの予定',
  fax: 'FAX',
  manual: '手入力',
}

// 絵文字版（<select><option> など画像を使えない箇所向け）
export function channelIcon(task) {
  return CHANNEL_ICONS[resolveChannel(task)] || CHANNEL_ICONS.email
}

// 画像版アイコンのパス
export function channelIconSrc(task) {
  return CHANNEL_ICON_SRC[resolveChannel(task)] || CHANNEL_ICON_SRC.email
}

export function channelLabel(task) {
  return CHANNEL_LABELS[resolveChannel(task)] || CHANNEL_LABELS.email
}

// 情報源フィルタ用の選択肢（value=channel, label=表示名, icon=絵文字）。
export const CHANNEL_OPTIONS = ['email', 'form', 'calendar', 'fax', 'manual'].map((value) => ({
  value,
  label: CHANNEL_LABELS[value],
  icon: CHANNEL_ICONS[value],
}))
