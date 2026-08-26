import { formatEquipmentDateReiwa } from '../lib/equipment'
import './EquipmentSlipSheet.css'

// 修理伝票PDF（2026-08-26）。この機能で扱う備品（ランプ等）は備後町コイズミビルの
// テナント設置分のみが対象のため、ビル名は固定表示にする（他ビルの備品管理は無い）。
const SLIP_BUILDING = '備後町コイズミビル'

// 1枚のA4縦に2件（半分ずつ）並べる、旧FileMaker帳票「修理伝票」を模したPDF出力専用シート。
// pair は必ず長さ2の配列（rec または null）。null は明細が奇数件のときの空欄。
// 画面には出さず、PDF化のときだけ画面外で描画して html2canvas で撮る
// （プロジェクトスキル print-and-pdf-download 参照。手書きCSSのみ・hex色のみで組む）。
export default function EquipmentSlipSheet({ pair }) {
  return (
    <div className="equip-slip-sheet">
      {pair.map((rec, i) => (
        <div className="equip-slip" key={rec ? rec.id : `empty-${i}`}>
          {rec && <SlipBody rec={rec} />}
        </div>
      ))}
    </div>
  )
}

function SlipBody({ rec }) {
  return (
    <>
      <div className="equip-slip-title">修　理　伝　票</div>
      <div className="equip-slip-meta">
        <span>取替日：　{formatEquipmentDateReiwa(rec.occurredAt)}</span>
        <span className="equip-slip-building">{SLIP_BUILDING}</span>
      </div>
      <table className="equip-slip-table equip-slip-tenant-table">
        <thead>
          <tr>
            <th>階</th>
            <th>テナント名</th>
            <th>受領印</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{rec.floor}</td>
            <td>{rec.tenantName} 様</td>
            <td className="equip-slip-sign-cell">
              {rec.signatureUrl && <img src={rec.signatureUrl} alt="受領印" className="equip-slip-sign-img" />}
            </td>
          </tr>
        </tbody>
      </table>
      <div className="equip-slip-lamp-head">◆ランプ取替</div>
      <table className="equip-slip-table equip-slip-lamp-table">
        <thead>
          <tr>
            <th>型番</th>
            <th>本数</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{rec.productCode}</td>
            <td>{rec.quantity}</td>
          </tr>
        </tbody>
      </table>
      <div className="equip-slip-staff">
        <div className="equip-slip-staff-label">担当者</div>
        <div className="equip-slip-staff-name">{rec.staffName}</div>
      </div>
    </>
  )
}
