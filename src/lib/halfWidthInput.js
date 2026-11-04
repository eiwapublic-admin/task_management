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
//
// 即座に半角へ（2026-11-04 依頼）: 日本語入力がオンのまま数字を打つと、確定（Enter）まで全角の未確定文字のまま
// 残り、その Enter が検針の「保存して次へ（Enter）」として効いてしまっていた（Mac の Safari は確定の Enter の
// keydown で isComposing が false になる）。そこで、変換中の文字が数字・記号だけなら、その場で欄から一瞬外して
// 戻す（blur → focus）ことで IME に確定させ、すぐ半角に直す。こうすると未確定の状態が残らず、確定の Enter も要らない。
// 一瞬外して戻す間の focus/blur は window の capture で止め、画面側（読み上げ・TimeInput の確定など）には届けない。
// ひらがな・英字の変換（電話番号欄にかな等）はこれまでどおり確定を待つ。

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

// 変換中の文字が数字・記号だけか（全角・半角とも）
const DIGIT_LIKE = /^[0-9\uFF10-\uFF19.,\uFF0E\uFF0C\-\uFF0D\u30FC\u2212+\uFF0B:\uFF1A/\uFF0F\s\u3000]+$/

// 一瞬外して戻している最中の欄（この間の focus/blur は画面側に届けない）
let refocusing = null

function commitNow(el) {
  if (!el.isConnected || document.activeElement !== el || !composing.has(el)) return
  const fromEnd = el.value.length - (el.selectionEnd ?? el.value.length)
  refocusing = el
  try {
    el.blur()
    el.focus({ preventScroll: true })
  } finally {
    refocusing = null
  }
  composing.delete(el)
  normalize(el, { notify: true })
  try {
    const pos = Math.max(0, el.value.length - fromEnd)
    el.setSelectionRange(pos, pos)
  } catch {
    // 何もしない
  }
}

export function installHalfWidthInput() {
  if (typeof window === 'undefined' || !valueSetter || window.__halfWidthInputInstalled) return
  window.__halfWidthInputInstalled = true

  for (const type of ['blur', 'focusout', 'focus', 'focusin']) {
    window.addEventListener(
      type,
      (e) => {
        if (refocusing && e.target === refocusing) e.stopImmediatePropagation()
      },
      true,
    )
  }

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
      if (refocusing === el) return
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
      if (e.isComposing || composing.has(el)) {
        // 数字・記号だけの変換中なら、IME のイベントが終わってから確定させて半角にする
        if (DIGIT_LIKE.test(e.data ?? '')) setTimeout(() => commitNow(el), 0)
        return
      }
      normalize(el, { notify: false })
    },
    true,
  )
}
