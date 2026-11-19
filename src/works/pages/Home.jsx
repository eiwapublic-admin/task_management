// ホーム。Phase 2 で「今日の予定」と出勤・退勤ボタンが入る
export default function Home({ user }) {
  const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
  return (
    <>
      <h1 className="works-title">ホーム</h1>
      <div className="ui-card works-today">
        <div className="ui-card-title">{today}</div>
        <p style={{ margin: 0 }}>
          {user?.staff ? `${user.staff.name} さん` : user?.display_name ? `${user.display_name} さん` : ''}
        </p>
        <p className="ui-note">出勤・退勤の打刻と今日の予定は、次の段階（Phase 2）でここに表示されます。</p>
      </div>
      {user?.works_admin && (
        <p className="ui-note">管理者メニュー: スタッフ・出退勤パターン・現場・設定 をメニューから開けます。</p>
      )}
    </>
  )
}
