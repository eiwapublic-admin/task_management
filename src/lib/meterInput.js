// メータの追加・修正画面の入力補助（2026-10-21。FileMaker のメータマスタの「入力値の自動化」「入力値の制限」と同じ規則）。
// 自動で入れるのは入れ先が空欄のときだけ（FileMaker の「既存の値が存在する場合は置き換えない」と同じ）。

// 全角英数・全角記号を半角に、前後の空白を除く（FileMaker の u_PlainText 相当）
export const plainText = (s) => String(s ?? '').normalize('NFKC').trim()

// バーコード（Code39）で使える文字。括弧が使えないので (x) は $x にする
export const CODE39_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ +-*/$.%'
export const METER_NO_MAX = 7

// メータ番号の整形: 半角・大文字にし、「(」→「$」、「)」→削除、「〜」「~」→「.」
export function normalizeMeterNo(s) {
  return plainText(s).toUpperCase().replace(/\(/g, '$').replace(/\)/g, '').replace(/[〜~]/g, '.')
}

// メータ番号の問題点（無ければ空文字）
export function meterNoProblem(no) {
  if (!no) return 'メータ番号を入力してください'
  const bad = [...new Set([...no].filter((c) => !CODE39_CHARS.includes(c)))]
  if (bad.length) return `メータ番号に使えない文字があります（${bad.join(' ')}）。使えるのは英数・スペースと「+-*/$.%」です`
  if (no.length > METER_NO_MAX) return `メータ番号は${METER_NO_MAX}文字以内にしてください（いま${no.length}文字）`
  return ''
}

// 1坪＝3.3㎡（FileMaker と同じ係数）。浮動小数の誤差で切り上げ・切り捨てがずれないよう、いったん丸めてから処理する
const settle = (n) => Math.round(n * 1e6) / 1e6
// ㎡ → 坪: 小数第1位まで（切り捨て）
export const m2ToTsubo = (m2) => Math.floor(settle((m2 * 10) / 3.3)) / 10
// 坪 → ㎡: 小数第2位まで（切り上げ）
export const tsuboToM2 = (tsubo) => Math.ceil(settle(tsubo * 330)) / 100

// 日付（YYYY-MM-DD）を月の1日にそろえる
export const firstOfMonth = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? `${d.slice(0, 8)}01` : d)

// 「貸室名＋請求明細補足」の組み合わせ（FileMaker の 貸室_補足。重複させない）
export const roomDetailKey = (roomName, detailNote) => `${plainText(roomName)} ${plainText(detailNote)}`
