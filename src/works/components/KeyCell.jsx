// 一覧表のキー項目（2026-11-20 依頼元の共通ルール）:
//   名称は太字、コードは名称の下に小さく薄い字。改行させず、横スクロールしても左に固定する（.works-key）。
//   見出し・合計の行は <th className="works-key"> を使う
export default function KeyCell({ name, code, children }) {
  return (
    <td className="works-key">
      <strong className="works-key-name">{name}</strong>
      {children}
      {code && <span className="works-key-code">{code}</span>}
    </td>
  )
}
