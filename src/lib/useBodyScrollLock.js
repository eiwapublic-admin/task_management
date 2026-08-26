import { useEffect } from 'react'

// モーダルを開いている間、裏側のページがスクロールしないように固定するフック。
//
// なぜ必要か（2026-08-10）:
// iPhone（日報一覧 → 日報詳細）で、モーダルの見出しが画面の上に隠れてしまい、
// 下にスワイプすると出てくる、という報告があった。裏の一覧が動ける状態のままだと、
// モーダル内でスクロールしきった勢いがそのまま裏へ伝わり（スクロールチェーン）、
// iOS では固定表示（position: fixed）のオーバーレイがその拍子にずれて見える。
// タスク詳細・タスク登録では以前から body を固定していて、この症状は出ていなかった。
//
// 入れ子のモーダル（日報詳細の上に自主点検・残留塩素）でも正しく動くよう、
// ロックしている数を数えて、最後の1つが閉じたときにだけ元へ戻す。
//
// アプリシェル導入（2026-08-26）により、実際にスクロールするのは body ではなく
// 各ページの .app-scroll 要素になった（body 自体は position: fixed で動かない）。
// そのため固定対象を .app-scroll に変更する。開いた時点で画面にある .app-scroll
// （＝表示中のページのもの）を覚えておき、閉じるときも同じ要素へ戻す。
let lockCount = 0
let lockedEl = null
let prevOverflow = ''

function lock() {
  lockCount += 1
  if (lockCount > 1) return
  lockedEl = document.querySelector('.app-scroll')
  if (!lockedEl) return
  prevOverflow = lockedEl.style.overflow
  lockedEl.style.overflow = 'hidden'
}

function unlock() {
  lockCount -= 1
  if (lockCount > 0) return
  if (lockedEl) lockedEl.style.overflow = prevOverflow
  lockedEl = null
}

export default function useBodyScrollLock(active = true) {
  useEffect(() => {
    if (!active) return undefined
    lock()
    return unlock
  }, [active])
}
