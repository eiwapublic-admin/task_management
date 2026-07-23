# ブラウザ別の詳細と根拠・コード例

SKILL.md の補足。各罠の一次的な背景と、参照実装から抜き出したコード例をまとめる。

## 目次
- [1. なぜ画像とPDFで方式を分けるのか](#1-なぜ画像とpdfで方式を分けるのか)
- [2. Safari の blob-PDF 問題](#2-safari-の-blob-pdf-問題)
- [3. Chrome の「接続が拒否されました」](#3-chrome-の接続が拒否されました)
- [4. 共通セキュリティヘッダの上書き回避](#4-共通セキュリティヘッダの上書き回避)
- [5. 短命プレビュートークン](#5-短命プレビュートークン)
- [6. テストで本番ヘッダを再現する](#6-テストで本番ヘッダを再現する)

## 1. なぜ画像とPDFで方式を分けるのか

blob URL（`URL.createObjectURL(blob)`）は、認証付き fetch で取ってきたバイナリを
そのまま `<img>`/`<iframe>` に渡せて便利。画像はこれで全環境安定する。
だが **PDF を `<iframe>` に blob URLで渡すと Safari だけ真っ白**になる。
そのため PDF だけ配信方式を変える。「全部 blob」でも「全部 実URL」でもなく、
**画像=blob / PDF=実URL** の混成が最も破綻が少ない。

## 2. Safari の blob-PDF 問題

WebKit（Safari の Mac 版・iOS 版とも同一エンジン）は、`blob:` スキームのPDFを
`<iframe>` 内のネイティブPDFビューアで開けない。iOS 8 の頃から報告があり、
現在も解消していない長年の既知問題。画像の blob URL は問題なく表示できるので、
これは PDF に固有。

**回避策**: PDF は blob をやめ、サーバの実URLへ `<iframe>` をナビゲートする。
実URLなら Safari もネイティブビューアを起動して描画する。ただし `<iframe src>` は
`Authorization` ヘッダを送れないため、認証はクエリの短命トークンで代替する（→5節）。
配信レスポンスは `Content-Disposition: inline`（`attachment` だとダウンロード扱いになり
プレビューにならない）。

フロント側（このリポジトリの `src/lib/api.js` より）:

```js
export async function getAttachmentPreviewUrl({ threadId, messageId, attachmentId, filename, mimeType }) {
  const { token } = await authFetch('/api/attachment/preview-token', {
    method: 'POST',
    body: JSON.stringify({ thread_id: threadId, message_id: messageId, attachment_id: attachmentId }),
  })
  const params = new URLSearchParams({
    thread_id: threadId, message_id: messageId, attachment_id: attachmentId,
    filename: filename || 'attachment', mime: mimeType || 'application/octet-stream',
    preview_token: token,
  })
  return `/api/attachment?${params.toString()}`  // ← これを <iframe src> に入れる
}
```

表示分岐（`src/components/TaskDetail.jsx` より）:

```js
const isPdf = att.mimeType === 'application/pdf'
const url = isPdf
  ? await getAttachmentPreviewUrl({ /* ...IDs... */ })                 // PDF: 実URL
  : URL.createObjectURL(await fetchAttachmentBlob({ /* ...IDs... */ })) // 画像: blob URL
```

## 3. Chrome の「接続が拒否されました」

2節で PDF を実URLにすると、今度は Chrome / Edge で iframe が
「〈host〉 で接続が拒否されました（refused to connect）」になる。これは TCP拒否ではなく、
**フレーム埋め込みがブロックされた時に Chrome が出す表示**。原因は、多くのアプリが
全レスポンスに付けている `X-Frame-Options: DENY` と CSP `frame-ancestors 'none'`。
これは他サイトからの埋め込み（クリックジャッキング）を防ぐ正しい設定だが、
**自サイト内のプレビューiframeも巻き添えで拒否**してしまう。

なお blob URL（2節以前）で表示できていたのは、blob URL はクライアント生成で
これらのレスポンスヘッダを持たないから。実URLにした瞬間にこの問題が顕在化する。

**対処**: プレビュー用レスポンス**だけ**同一オリジン限定に緩める（`worker/index.js` より）:

```js
const headers = {
  'Content-Type': mimeType,
  'Content-Disposition': `${disposition}; filename="..."`,
  'Cache-Control': 'private, no-store',
}
if (viaPreviewToken) {
  headers['X-Frame-Options'] = 'SAMEORIGIN'
  headers['Content-Security-Policy'] = "frame-ancestors 'self'"
}
return new Response(bytes, { headers })
```

`X-Frame-Options: DENY` と CSP `frame-ancestors 'self'` が混在すると、
より厳しい DENY が勝って結局ブロックされる。だから **両方**を SAMEORIGIN / 'self' に
揃えること。

## 4. 共通セキュリティヘッダの上書き回避

多くのアプリは「全レスポンスに一律でセキュリティヘッダを付ける」ラッパを持つ。
3節でレスポンス側が `X-Frame-Options: SAMEORIGIN` を設定しても、このラッパが
最後に `DENY` で上書きしてしまうと無意味になる。ラッパは**既に設定済みなら尊重**する
（`worker/lib/http.js` より）:

```js
export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers)
  if (!headers.has('X-Frame-Options')) {   // ← 既存値があれば上書きしない
    headers.set('X-Frame-Options', 'DENY') // 既定は全面禁止のまま
  }
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  if (!headers.has('Content-Security-Policy')) {  // CSPも同様に条件付き
    headers.set('Content-Security-Policy', DEFAULT_CSP)
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
```

## 5. 短命プレビュートークン

`<iframe src>` が Authorization ヘッダを送れない問題を、クエリ文字列の署名トークンで解く。
既存の JWT 署名（HS256 / Web Crypto の `crypto.subtle`）を流用できる。設計の肝:

- **対象IDを署名対象に含める**（thread/message/attachment 等）。これにより発行された
  トークンは**その添付にしか使えない**（他の添付の窃取に転用不可）。
- **有効期限を短く**（例: 120秒）。プレビューを開く一瞬だけ有効ならよい。
- 発行エンドポイントは要ログイン。配信エンドポイントは、トークンの purpose と対象IDが
  一致する場合に限り通常認証の代わりに受理。

```js
// 発行（POST /api/attachment/preview-token、要ログイン）
const token = await signJwt(
  { purpose: 'attachment-preview', threadId, messageId, attachmentId },
  SESSION_SECRET, 120)
return json({ token })

// 検証（GET /api/attachment 側）
const claims = SESSION_SECRET ? await verifyJwt(previewToken, SESSION_SECRET) : null
const viaPreviewToken = !!claims &&
  claims.purpose === 'attachment-preview' &&
  claims.threadId === threadId &&
  claims.messageId === messageId &&
  claims.attachmentId === attachmentId
if (!viaPreviewToken && !(await verifyRequestAuth(req))) return json({ error: '認証が必要です' }, 401)
```

単一利用（one-time）にはしていない — S3 の presigned URL 同様、対象を絞った短命URLとして
割り切った設計。要件が厳しければ使い捨て化も可能だが、状態管理のコストが増える。

## 6. テストで本番ヘッダを再現する

`vite preview` 等の開発サーバは Worker/本番の CSP・X-Frame-Options を付けない。
だから Playwright/Chromium テストはヘッダ由来の不具合を再現しない（実際、CSP起因の
「画像が出ない」も XFO起因の「接続拒否」も、ローカルは全部パスして実機で初めて発覚した）。

Playwright で navigation レスポンスに本番ヘッダを注入して再現する例:

```js
await page.route('http://localhost:PORT/', async route => {
  const response = await route.fetch()
  const headers = response.headers()  // route.fetch() の戻りは headers()（同期・plain object）
  await route.fulfill({ response, headers: { ...headers,
    'content-security-policy': PROD_CSP,
    'x-frame-options': 'DENY',
  }})
})
```

ただし **Safari固有の描画バグ（blob-PDF）は Chromium では再現しない**ので、
この手法でも捕まらない。特定ブラウザだけの症状は、そのエンジンの実機で確認するのが確実。

添付ルートのモックで注意: glob `**/api/attachment*` は `/api/attachments`（複数形=一覧API）
にもマッチして衝突する。`RegExp` で `/\/api\/attachment\?/` と `/\/api\/attachments\?/` を
`?` で区別する。
