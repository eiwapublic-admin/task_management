import useStickyHeightVar from '../lib/useStickyHeightVar'

// 機能ヘッダ（画面構成の2層目。2026-08-12）
//
//   1. アプリヘッダ（AppHeader）… アプリアイコン・機能名・ユーザー・メニュー
//   2. 機能ヘッダ（この部品）  … 左＝年月/表示切替/絞り込み、右＝機能ボタン
//   3. 本体                    … 一覧。縦スクロールしても 1・2 は固定表示のまま
//
// **画面名は原則としてアプリヘッダのタイトルが示すので、title は渡さない**（2026-08-12。
// セクション切替を廃止してヘッダーに機能名を大きく出す形にした際、同じ名前が2箇所に
// 出てしまうため各画面から外した）。title を使うのは、画面名ではなく「いま何を見ているか」が
// データで決まる場合だけ（例: 備品の履歴画面＝対象の備品名）。
//
// AppHeader の下に積んで固定表示するための高さ計測（--sticky2-h）もここで行うので、
// 各画面が useStickyHeightVar を個別に呼ぶ必要はない。3段目（表の列見出し・カレンダーの
// 曜日行など）は従来どおり .ui-sticky-head-2 を付ければこの下に積み上がる。
//
// 使い方:
//   <FeatureHeader
//     title={item?.name}                        // 通常は省略する（上の注記を参照）
//     leading={<button className="icon-btn-home" …/>}  // 戻るボタン等（タイトルの前）
//     filters={<>…年月の移動・表示切替・絞り込み…</>}
//     actions={<>…機能ボタン…</>}
//   >
//     {/* 開閉する検索欄など、ヘッダーに追従させたい行があれば children に置く */}
//   </FeatureHeader>
export default function FeatureHeader({ title, leading, filters, actions, className = '', children }) {
  const headRef = useStickyHeightVar('--sticky2-h')
  const hasMain = Boolean(leading || title || filters)

  return (
    <div className={`ui-feature-head${className ? ` ${className}` : ''}`} ref={headRef}>
      <div className="ui-feature-head-row">
        {hasMain && (
          <div className="ui-feature-head-main">
            {leading}
            {title && <h2 className="ui-page-title">{title}</h2>}
            {filters}
          </div>
        )}
        {actions && <div className="ui-feature-head-actions">{actions}</div>}
      </div>
      {children}
    </div>
  )
}
