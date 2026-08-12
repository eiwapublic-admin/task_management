import useStickyHeightVar from '../lib/useStickyHeightVar'

// 機能ヘッダ（画面構成の2層目。2026-08-12）
//
//   1. アプリヘッダ（AppHeader）… アプリアイコン・セクション切替・ユーザー・メニュー
//   2. 機能ヘッダ（この部品）  … 左＝年月/表示切替/絞り込み、右＝機能ボタン
//   3. 本体                    … 一覧。縦スクロールしても 1・2 は固定表示のまま
//
// 機能名（タスク／日報／備品）はアプリヘッダのセクション切替が示すため、主要3画面では
// title を渡さない。サブ画面（アーカイブ・自主検査表・違反車両など）は現在地が切替から
// 読み取れないので title を渡す。
//
// AppHeader の下に積んで固定表示するための高さ計測（--sticky2-h）もここで行うので、
// 各画面が useStickyHeightVar を個別に呼ぶ必要はない。3段目（表の列見出し・カレンダーの
// 曜日行など）は従来どおり .ui-sticky-head-2 を付ければこの下に積み上がる。
//
// 使い方:
//   <FeatureHeader
//     title="アーカイブ"                        // 主要3画面では省略する
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
