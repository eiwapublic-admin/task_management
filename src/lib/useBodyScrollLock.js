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
// なお html 側には掛けない。html を overflow:hidden にすると裏のページのスクロール
// 位置が先頭へ戻ってしまい、閉じたときに一覧の見ていた場所を見失う。
let lockCount = 0
let prevBodyOverflow = ''

function lock() {
  lockCount += 1
  if (lockCount > 1) return
  prevBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
}

function unlock() {
  lockCount -= 1
  if (lockCount > 0) return
  document.body.style.overflow = prevBodyOverflow
}

export default function useBodyScrollLock(active = true) {
  useEffect(() => {
    if (!active) return undefined
    lock()
    return unlock
  }, [active])
}
