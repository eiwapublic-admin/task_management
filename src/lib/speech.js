// 検針値の読み上げ（2026-10-20〜。docs/meter-plan.md 3-3）。FileMaker の入力画面の♩ボタンの代わり。
// ブラウザの音声合成（Web Speech API。無料・外部通信なし）で、数字を一桁ずつ読む
// （「63796」→「ろく さん なな きゅう ろく」）。聞き違えにくいよう 4 は「よん」、7 は「なな」、9 は「きゅう」

const DIGITS = ['ぜろ', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう']

export function speechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
}

// 数字の並びを読み上げ用の文に直す。数字以外（小数点など）は「てん」等に置き換える
export function digitsToSpeech(value) {
  return String(value ?? '')
    .split('')
    .map((c) => (c >= '0' && c <= '9' ? DIGITS[Number(c)] : c === '.' ? 'てん' : c === '-' ? 'まいなす' : ''))
    .filter(Boolean)
    .join('、')
}

// 前月比の読み上げ（2026-11-02 依頼）。使用量（total）と前月の使用量（prevTotal）から増減の割合を出し、
// 「前月比、20パーセント増加」「…減少」と読む。割合は四捨五入で 0% なら「前月比、変化なし」、
// 今月も前月も使用量が 0 なら「未使用のまま変化なし」。前月の使用量が無い・0（今月は使用あり）のときは
// 割合が出せないので読まない（空文字）
export function ratioToSpeech(total, prevTotal) {
  if (total == null || prevTotal == null || !Number.isFinite(total) || !Number.isFinite(prevTotal)) return ''
  if (total === 0 && prevTotal === 0) return '未使用のまま変化なし'
  if (prevTotal <= 0) return ''
  const pct = Math.round((total / prevTotal - 1) * 100)
  if (pct === 0) return '前月比、変化なし'
  return `前月比、${Math.abs(pct)}パーセント${pct > 0 ? '増加' : '減少'}`
}

let japaneseVoice = null
function pickVoice() {
  if (japaneseVoice) return japaneseVoice
  const voices = window.speechSynthesis.getVoices()
  japaneseVoice = voices.find((v) => v.lang === 'ja-JP' && v.localService) || voices.find((v) => v.lang?.startsWith('ja')) || null
  return japaneseVoice
}

let lastBody = ''

// 値を読み上げる。前の読み上げが残っていれば止めてから読む。
// 外調機のように値が2つあるときは配列で渡すと「…、ふたつめ、…」と続けて読む。
// skipIfSpeaking: 同じ文をいま読んでいる途中なら読み直さない（入力欄から離れたときの読み上げの直後に
// 「保存」ボタンを押したとき、同じ数字を頭から読み直さないため。2026-10-26〜）
// suffix: 数字のあとに続けて読む文（前月比。ratioToSpeech の結果。2026-11-02〜）
export function speakValue(value, { skipIfSpeaking = false, suffix = '' } = {}) {
  if (!speechSupported()) return false
  const values = (Array.isArray(value) ? value : [value]).filter((v) => v != null && v !== '')
  const digits = values.map(digitsToSpeech).filter(Boolean).join('、ふたつめ、')
  if (!digits) return false
  const body = suffix ? `${digits}。${suffix}` : digits
  const synth = window.speechSynthesis
  if (skipIfSpeaking && body === lastBody && (synth.speaking || synth.pending)) return true
  lastBody = body
  synth.cancel()
  const u = new SpeechSynthesisUtterance(body)
  u.lang = 'ja-JP'
  u.rate = 0.95
  const voice = pickVoice()
  if (voice) u.voice = voice
  synth.speak(u)
  return true
}
