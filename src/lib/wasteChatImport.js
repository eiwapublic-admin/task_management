import { WASTE_FLOORS } from './waste'
import { daysInMonth } from './reports'

// チャットでの読み取り結果の貼り付け（2026-11-11〜。docs/waste-plan.md 10-11）。
// アプリからAIを呼ぶとAnthropicのAPIクレジットを使い、撮り直すたびに費用がかかるため、
// 依頼元が契約しているClaudeのチャット（claude.ai。定額）に写真と依頼文を渡して読ませ、
// 返ってきたCSVを貼り付けて、アプリ側の読み取り（10-10）と同じ確認画面に流す。
// 依頼文の中身は worker/lib/ai/prompts.js の buildWastePhotoPrompt と揃えること。

/**
 * チャットに貼る依頼文。写真と一緒に送ってもらう。
 * @param {string} month 'YYYY-MM'
 */
export function buildWasteChatPrompt(month) {
  const [y, m] = month.split('-').map(Number)
  const lastDay = daysInMonth(month)
  return [
    `添付の写真は「BKBビル 廃棄物実測集計表」の${y}年${m}月分（1日〜${lastDay}日）で、手書きで記入されています。`,
    '表の列は左から「日」「曜日」「1F」「2F」「3F」「4F」「5F」「6F」「7F」「合計」で、各マスには一般廃棄物の重さ（kg）が小数で書かれています。',
    '1F〜7Fと右端の「合計」欄の数値を、日ごとにそのまま読み取ってください。',
    '',
    '【読み方の注意】',
    '- 空欄、または線や記号だけで数字が書かれていないマスは空にしてください。',
    '- 二重線などで訂正されているマスは、訂正後の数値を読んでください。',
    '- 小数点は小さく書かれがちです。1F〜7Fは多くの場合0〜20kg程度なので、小数点の見落とし（例: 2.77 を 277 と読む）に注意してください。',
    '- 数字が罫線をまたいでいる場合は、数字の大部分がある欄の値とします。列を取り違えないよう、縦の罫線と見出しを基準に確かめてください。',
    '- 表のいちばん下の「合計」行（月の合計）は読まないでください。',
    '- 各行で1F〜7Fの和と「合計」欄が合わないときは、その行をもう一度よく見直してください。見直しても合わなければ、見えたとおりの値を書いてください（合計に合わせて数値を作らないこと）。',
    '- 判読に自信がないマスは、いちばん可能性の高い読みの後ろに「?」を付けてください（例: 2.5?）。',
    '',
    '【答え方】',
    `次の形式のCSVだけを、1つのコードブロックで返してください。1日〜${lastDay}日を1行ずつ必ず${lastDay}行（記入のない日も「日」だけの行を入れる）。説明は不要です。`,
    '```',
    '日,1F,2F,3F,4F,5F,6F,7F,合計',
    '1,2.77,2.1,,1.07,2.71,,3.1,11.83',
    '2,,,,,,,,',
    '```',
  ].join('\n')
}

const EMPTY_MARKS = new Set(['', '-', '―', '－', 'ー', '/', '／', 'null', 'なし'])

// 1マスの文字列を { text, unclear } に整える。数値でない文字はそのまま残し、確認画面で赤枠にする
function cellOf(raw) {
  let t = String(raw ?? '').normalize('NFKC').trim()
  let unclear = false
  if (/[?？]$/.test(t)) {
    unclear = true
    t = t.replace(/[?？]+$/, '').trim()
  }
  t = t.replace(/\s*kg$/i, '')
  if (EMPTY_MARKS.has(t.toLowerCase())) t = ''
  return { text: t, unclear }
}

function splitLine(line) {
  if (line.includes('\t')) return line.split('\t')
  if (line.includes('|')) {
    // マークダウンの表（| 1 | 2.77 | … |）。前後の | を落としてから区切る
    return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
  }
  return line.split(/[,，、]/)
}

/**
 * 貼り付けられたCSV（タブ区切り・マークダウンの表も可）を確認画面用の行に変換する。
 * 曜日の列が入っていても読み飛ばす。見出し行・月合計行・範囲外の日は無視する。
 * @returns {{ day: number, floors: Record<string,string>, total: string, unclear: string[] }[]}
 *   月の全日分（貼り付けに無い日は空欄）
 * @throws 読める行が1行も無いとき
 */
export function parseWasteChatText(text, month) {
  const lastDay = daysInMonth(month)
  const byDay = new Map()
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('```')) continue
    let cells = splitLine(line).map((c) => c.trim())
    const dayMatch = /^(\d{1,2})\s*日?$/.exec(String(cells[0] || '').normalize('NFKC'))
    if (!dayMatch) continue
    const day = Number(dayMatch[1])
    if (day < 1 || day > lastDay || byDay.has(day)) continue
    cells = cells.slice(1)
    // 2列目が曜日（数字を含まない1〜3文字の語）なら読み飛ばす
    if (cells.length > 0 && /^[日月火水木金土祝()（）]{1,4}$/.test(cells[0].normalize('NFKC'))) cells = cells.slice(1)

    const floors = {}
    const unclear = []
    WASTE_FLOORS.forEach((f, i) => {
      const c = cellOf(cells[i])
      floors[f] = c.text
      if (c.unclear) unclear.push(f)
    })
    const t = cellOf(cells[WASTE_FLOORS.length])
    if (t.unclear) unclear.push('total')
    byDay.set(day, { day, floors, total: t.text, unclear })
  }
  if (byDay.size === 0) {
    throw new Error('読み取り結果の形式が違います。チャットが返した「日,1F,2F,…」のCSVをそのまま貼り付けてください。')
  }
  const rows = []
  for (let day = 1; day <= lastDay; day += 1) {
    rows.push(
      byDay.get(day) || { day, floors: Object.fromEntries(WASTE_FLOORS.map((f) => [f, ''])), total: '', unclear: [] }
    )
  }
  return rows
}
