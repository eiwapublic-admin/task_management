// フラットデザインのラインアイコン（2026-08-05）。
// 絵文字は使わず、線画のSVGに統一する（「タスク管理標準」）。
// このアプリは外部アイコンライブラリを使わない方針のため、必要な分だけ自前で用意する。

function Icon({ size = 20, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export function IconHome(props) {
  return (
    <Icon {...props}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
    </Icon>
  )
}

export function IconChevronLeft(props) {
  return (
    <Icon {...props}>
      <polyline points="15 6 9 12 15 18" />
    </Icon>
  )
}

export function IconChevronRight(props) {
  return (
    <Icon {...props}>
      <polyline points="9 6 15 12 9 18" />
    </Icon>
  )
}

export function IconTrash(props) {
  return (
    <Icon {...props}>
      <polyline points="4 7 6 7 20 7" />
      <path d="M18 7l-1 13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </Icon>
  )
}

export function IconClipboard(props) {
  return (
    <Icon {...props}>
      <rect x="8" y="3" width="8" height="4" rx="1" />
      <path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
    </Icon>
  )
}

export function IconGear(props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Icon>
  )
}

export function IconCar(props) {
  return (
    <Icon {...props}>
      <path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11" />
      <rect x="3" y="11" width="18" height="6" rx="2" />
      <circle cx="7.5" cy="18.5" r="1.5" />
      <circle cx="16.5" cy="18.5" r="1.5" />
    </Icon>
  )
}

export function IconClip(props) {
  return (
    <Icon {...props}>
      <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l8.49-8.48a4 4 0 0 1 5.66 5.66l-8.49 8.48a2 2 0 0 1-2.83-2.83l7.78-7.78" />
    </Icon>
  )
}

export function IconCheckCircle(props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 8.5" />
    </Icon>
  )
}

export function IconDownload(props) {
  return (
    <Icon {...props}>
      <path d="M12 3v12" />
      <polyline points="7 10 12 15 17 10" />
      <path d="M4 19h16" />
    </Icon>
  )
}

// 日報一覧の表示切替（リスト型／カレンダー型。2026-08-07）
export function IconList(props) {
  return (
    <Icon {...props}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </Icon>
  )
}

export function IconCalendar(props) {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 3v4M16 3v4" />
    </Icon>
  )
}
