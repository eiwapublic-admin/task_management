// 数値・日付・時刻の入力欄で、全角の文字を半角に直す（2026-11-02 依頼。アプリ全体）。
//
// 対象: <input> のうち inputmode が numeric / decimal / tel のもの、type が tel のもの、
//       data-halfwidth 属性を付けたもの（数字を打つ欄。検針の当月値・TimeInput の時刻など）。
//       type="number" / "date" / "time" / "month" はブラウザの部品が全角を受け付けないので対象外。
//
// 二重入力を起こさないための決まり:
//   - 日本語入力（IME）で変換中（compositionstart〜compositionend の間）は値に一切触らない。
//     変換中に値を書き換えると、確定のときに IME が同じ文字をもう一度入れて「１１」→「11１」のように二重になる。
//   - 確定（compositionend）のあとは、次の描画の前（setTimeout 0）に1回だけ直す。
//     ブラウザによって compositionend と最後の input の順番が違う（Chrome: input→compositionend、
//     Safari: compositionend→input）ので、どちらでも確定が終わってから触るように遅らせる。
//   - 変換を経ない入力（全角のまま直接入力・貼り付け）は、React より先に（window の capture で）
//     その場で直すので、画面の state には最初から半角が入る。
//   - 値の書き換えは HTMLInputElement の本来の setter で行う。React の制御された入力欄は
//     el.value = … だと変化に気づかないため（気づかせるため input イベントを送り直す）。
//   - 文字は1対1で置き換えるので、カーソルの位置はそのまま戻せる。

const TARGET_INPUTMODES = new Set(['numeric', 'decimal', 'tel'])

export function isHalfWidthTarget(el) {
  if (!el || el.tagName !== 'INPUT' || el.readOnly || el.disabled) return false
  if (el.hasAttribute('data-halfwidth')) return true
  const type = (el.getAttribute('type') || 'text').toLowerCase()
  if (type === 'tel') return true
  if (type !== 'text' && type !== 'search') return false
  return TARGET_INPUTMODES.has((el.getAttribute('inputmode') || '').toLowerCase())
}

// 全角英数記号（！〜～）→ 半角、全角スペース → 半角スペース、長音・ダッシュ・マイナス類 → '-'
export function toHalfWidth(text) {
  return String(text ?? '').replace(/[！-～　ー‐-―−ｰ]/g, (c) => {
    const code = c.charCodeAt(0)
    if (code === 0x3000) return ' '
    if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0)
    return '-'
  })
}

const valueSetter = typeof window !== 'undefined' ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set : null

// 値を半角に直す。変えたら true
function normalize(el, { notify }) {
  const before = el.value
  const after = toHalfWidth(before)
  if (after === before) return false
  let start = null
  let end = null
  try {
    start = el.selectionStart
    end = el.selectionEnd
  } catch {
    // selection を持たない種類（念のため）
  }
  valueSetter.call(el, after)
  if (start != null && document.activeElement === el) {
    try {
      el.setSelectionRange(start, end)
    } catch {
      // 何もしない
    }
  }
  if (notify) el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

const composing = new WeakSet()

export function installHalfWidthInput() {
  if (typeof window === 'undefined' || !valueSetter || window.__halfWidthInputInstalled) return
  window.__halfWidthInputInstalled = true

  window.addEventListener(
    'compositionstart',
    (e) => {
      if (isHalfWidthTarget(e.target)) composing.add(e.target)
    },
    true,
  )

  window.addEventListener(
    'compositionend',
    (e) => {
      const el = e.target
      if (!isHalfWidthTarget(el)) return
      composing.delete(el)
      setTimeout(() => {
        // その間に次の変換が始まっていたら触らない（その変換の確定でまた直す）
        if (composing.has(el) || !el.isConnected) return
        normalize(el, { notify: true })
      }, 0)
    },
    true,
  )

  // React（root で受ける）より先に直すため window の capture で受ける
  window.addEventListener(
    'input',
    (e) => {
      const el = e.target
      if (!isHalfWidthTarget(el)) return
      if (e.isComposing || composing.has(el)) return
      normalize(el, { notify: false })
    },
    true,
  )
}
