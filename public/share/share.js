// 共有リンクの受け取りページ（worker/lib/secure-shares.js の handleSharePage）で、「開く」を押したときの反応を出す（2026-10-26〜）。
// PDF はダウンロードとして返るのでページが切り替わらず、押しても何も起きないように見えて何度も押されていた。
// フォームの送信そのものは素の HTML のまま（この JS が動かなくても開ける）。
// 送信のたびに乱数の目印（dl）を付け、サーバーは PDF を返すときに同じ値の Cookie（share_dl）を付ける。
// その Cookie が見えたら「ダウンロードを始めました」と出す。パスワードが違うときはサーバーがページごと返し直す
;(function () {
  var form = document.querySelector('form')
  var button = document.getElementById('open')
  var status = document.getElementById('status')
  var left = document.getElementById('left')
  if (!form || !button || !status) return
  var label = button.textContent
  var timer = null

  function show(text, cls) {
    status.hidden = false
    status.className = 'status' + (cls ? ' ' + cls : '')
    status.textContent = text
  }

  form.addEventListener('submit', function (e) {
    if (timer) {
      e.preventDefault()
      return
    }
    var dl = Math.random().toString(36).slice(2, 12) + Date.now().toString(36)
    var input = form.querySelector('input[name="dl"]')
    if (!input) {
      input = document.createElement('input')
      input.type = 'hidden'
      input.name = 'dl'
      form.appendChild(input)
    }
    input.value = dl
    button.disabled = true
    button.textContent = 'ダウンロードを準備しています…'
    show('しばらくお待ちください。')
    var started = Date.now()
    timer = setInterval(function () {
      var done = document.cookie.indexOf('share_dl=' + dl) !== -1
      if (!done && Date.now() - started < 20000) return
      clearInterval(timer)
      timer = null
      button.disabled = false
      if (done) {
        button.textContent = 'もう一度ダウンロード（回数を1回使います）'
        show('ダウンロードを始めました。ブラウザのダウンロード（画面の上部・下部の↓や「ファイル」アプリ）をご確認ください。', 'ok')
        if (left) {
          var n = parseInt(left.textContent, 10)
          if (n > 0) left.textContent = String(n - 1)
        }
      } else {
        button.textContent = label
        show('応答に時間がかかっています。ダウンロードの一覧を確かめてから、必要ならもう一度押してください。')
      }
    }, 300)
  })
})()
