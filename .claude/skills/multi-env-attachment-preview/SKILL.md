---
name: multi-env-attachment-preview
description: >-
  Webアプリで添付ファイル（PDF・画像）を「アプリ内でプレビュー表示」する機能を、
  Safari(Mac/iOS)・Chrome・Edge・Firefox などマルチ環境で確実に動かすための知見集。
  ブラウザごとに異なる罠（Safariはblob URLのPDFをiframeで描画できない、Chromeは実URLの
  iframe埋め込みがX-Frame-Options/CSPで拒否される、CSPのimg-src/frame-srcにblob:が要る、
  dev/previewサーバは本番のセキュリティヘッダを付けないためローカルテストで再現しない等）を
  先回りして回避する。次のような場面では必ずこのスキルを参照すること: 添付ファイルやアップロード
  ファイルのアプリ内プレビュー/インライン表示/モーダル表示を作る、PDFや画像を`<iframe>`や
  `<img>`で表示する、`URL.createObjectURL()`のblob URLで表示する、「PDFが真っ白」「画像が
  表示されない/壊れて見える」「接続が拒否されました(refused to connect)」「Safariだけ表示
  できない」「Chromeだけ表示できない」といった不具合を調査/修正する、プレビューにピンチや
  ホイールでのズームを付ける、といったとき。ブラウザ差分の話が明示されていなくても、
  ファイルのインラインプレビューを扱うなら参照する。
---

# マルチ環境での添付ファイル（PDF・画像）プレビュー表示

Webアプリで PDF・画像をダウンロードさせるだけでなく「アプリ内でその場でプレビュー表示」
する機能は、一見simpleだが**ブラウザごとに罠が異なり**、1つの実装が全環境で動くとは限らない。
このスキルは、実運用のタスク管理アプリ（Cloudflare Workers + 自前APIで Gmail 添付を配信）で
実際に踏んだ罠と、その回避策を一般化してまとめたもの。新規に作るときも、既存のプレビューの
不具合を直すときも、まずここを読んで「どの環境で何が起きるか」を先に把握してから着手する。

## いちばん大事な結論（先に読む）

プレビューの表示方式は、**画像とPDFで分けるのが正解**。同じ方式で両方やろうとすると必ずどこかで割れる。

- **画像** → `URL.createObjectURL()` の **blob URL** を `<img src>` に入れる。全環境で安定。
  ズームも自前で実装できる（後述）。
- **PDF** → blob URL を `<iframe>` に入れる方式は **Safari(WebKit)で真っ白になる**。
  代わりに **同一オリジンの実URL**（短時間有効な署名付きトークンで保護）へ `<iframe>` を
  ナビゲートし、レスポンスを `Content-Disposition: inline` で返す。さらにそのレスポンスだけ
  **フレーム埋め込みを同一オリジンに許可**する（でないと Chrome で「接続が拒否されました」）。

この2点を外すと、必ず「Safariだけ真っ白」か「Chromeだけ接続拒否」のどちらかに落ちる。

## 環境別の罠と対処（マトリクス）

| 症状 | 起きる環境 | 原因 | 対処 |
|---|---|---|---|
| 画像が壊れて見える / PDFが真っ白（全ブラウザ） | 全環境 | CSPの `img-src`/`frame-src` に `blob:` が無く、blob URLがブロックされる | `img-src` と `frame-src` に `blob:` を追加（下記CSP節） |
| PDFだけ真っ白（画像は出る、Chromeでは出る） | **Safari (Mac / iOS 両方 = WebKit)** | WebKitは blob URL のPDFを`<iframe>`内に描画できない（iOS8以降の長年の既知問題、未解消） | PDFは blob をやめ、短時間有効トークン付きの**実URL**へ`<iframe>`をナビゲート、`Content-Disposition: inline` |
| PDFが「接続が拒否されました / refused to connect」 | **Chrome / Edge 等**（実URL方式にした後） | 全レスポンス共通の `X-Frame-Options: DENY` と CSP `frame-ancestors 'none'` が、同一オリジンのプレビューiframeもブロック | そのプレビュー用レスポンス**だけ** `X-Frame-Options: SAMEORIGIN` + CSP `frame-ancestors 'self'` に緩和 |
| Authヘッダを付けられない | iframe全般 | `<iframe src>` は `Authorization` ヘッダを送れない | 認証はクエリ文字列の**短命な署名トークン**で代替（Bearerの代わり） |
| ローカルでは再現しないのに本番で壊れる | dev/preview全般 | `vite preview` 等の開発サーバは**本番のCSP/セキュリティヘッダを付けない** | 本番ヘッダを再現してテストするか、デプロイ済み環境で実機確認（下記テスト節） |

詳しい背景・コード例は `references/browser-matrix.md` を参照。

## 実装の型（この構成をベースにする）

### 1. CSP に blob: を通す

blobでのプレビュー（画像は常時、PDFも初期実装で）を使うなら、CSPに `blob:` が要る。
外部オリジンを許すわけではないのでリスク増は無い。

```
img-src 'self' data: blob:
frame-src 'self' blob:
```

`frame-src` を明示しないと `default-src 'self'` にフォールバックして blob: が弾かれる点に注意。

### 2. PDFは「短命トークン付き実URL + inline」で配信する

blobではなく、サーバの実エンドポイント（例: `GET /api/attachment?...`）へ `<iframe>` を
ナビゲートする。`<iframe src>` は Authorization ヘッダを送れないので、認証は
**クエリ文字列の短命な署名トークン**で代替する:

- 別エンドポイント（例: `POST /api/attachment/preview-token`、要ログイン）で、
  対象を一意に特定するID（thread/message/attachment 等）を**署名に含めた**JWTを発行。
  有効期限は短く（例: 120秒）。他の添付に転用できないよう対象IDを署名対象にするのが肝。
- 配信エンドポイントは、その `preview_token` が対象と一致する場合に限り通常の認証の代わりに
  受け付け、`Content-Disposition: inline` で返す（通常ダウンロード時は `attachment`）。

これで Safari でもネイティブPDFビューアが起動して描画される。

### 3. プレビュー用レスポンスだけフレーム埋め込みを許可する

多くのアプリは全レスポンスに `X-Frame-Options: DENY` / CSP `frame-ancestors 'none'` を
付けている（クリックジャッキング対策として正しい）。だが実URL方式のPDFは**自サイトの
iframeに埋め込む**ので、これに引っかかって Chrome 等で「接続が拒否されました」になる。

対処は、**プレビュー用レスポンスに限って**自オリジン限定に緩めること:

```
X-Frame-Options: SAMEORIGIN
Content-Security-Policy: frame-ancestors 'self'
```

そして共通のセキュリティヘッダ付与関数は、**レスポンスが既に X-Frame-Options を
設定済みなら上書きしない**ようにする（でないと SAMEORIGIN が DENY で潰される）。
`X-Frame-Options: DENY` と `frame-ancestors 'self'` が混在すると DENY が勝つので、
**両方**を SAMEORIGIN / 'self' に揃える必要がある。他サイトからの埋め込みは引き続き
禁止されるので、クリックジャッキング対策は損なわれない。

### 4. ズーム

- **画像**: blob URLの`<img>`に自前ズームを付ける。外部ライブラリ不要。
  ホイール（`preventDefault`して倍率変更）、ダブルクリックでトグル、ドラッグ移動は
  Pointer Events + `setPointerCapture`、2本指ピンチは raw Touch Events（`e.touches.length===2`）。
  倍率は例として 1〜5倍にクランプ。コンテナに `touch-action: none` を付けてブラウザ標準の
  スクロール/ズームを無効化し、自前制御に一本化する。
- **PDF**: ブラウザ内蔵のPDFビューアが自前のズームを持つので、独自ズームは不要。
  （実URL方式にして初めてこのネイティブビューアが起動する点に注意 — blob方式だと起動しない）

### 5. ネストしたモーダルのイベント分離

プレビューを親モーダル（詳細画面等）の上に重ねる場合:
- 背景クリックで閉じる処理は `e.stopPropagation()` してから自分の onClose を呼ぶ
  （でないと親モーダルの背景クリックにも伝播して両方閉じる）。
- Escapeキーは `stopPropagation` では**同じ document の他リスナは止まらない**。
  親側は「プレビューが開いているか」を ref（state ではなく `useRef`。stale closure と
  依存配列の問題を避けるため）で見て、開いている間は自分のキー処理を早期 return でスキップする。

## テストの注意（ここで何度も騙された）

- **dev/previewサーバは本番のCSP・X-Frame-Optionsを付けない。** `vite preview` の
  Playwright/Chromium テストは、これらのヘッダ由来の不具合を**一切再現しない**。
  実際、CSP起因の「画像が出ない」も、X-Frame-Options起因の「接続が拒否されました」も、
  ローカルテストは全部パスして本番の実機報告で初めて発覚した。
- 対策: テスト時に**本番のヘッダを再現する**（例: Playwrightで navigation レスポンスに
  `page.route(...)` で本番CSP/`X-Frame-Options`を注入して fulfill する）か、
  デプロイ済み環境で実機確認する。ヘッダ系の挙動を本気で検証したいならこれは必須。
- **Safari固有・WebKit固有の描画問題は Chromium では再現しない。** blob-PDF問題は
  Chromeでは普通に表示できてしまうため、Chromiumテストでは絶対に捕まらない。この種の
  「特定ブラウザだけ」の報告は、そのブラウザ（実機 or 同エンジン）で確認するしかない。
- 署名トークンの検証（正しい対象は通る/期限切れ・別対象・別シークレットは弾く）は、
  Web Crypto API だけで書いてあれば Node 20+ 単体で round-trip テストできる。

## 検証状況（2026-08-03 時点）

実機で**表示OK確認済み**: iOS Safari / Mac Safari / Mac Chrome / Windows（PDF・画像とも）。
**未検証**: Android（Chrome）。
未検証環境で不具合報告が来たら、上のマトリクスに症状・原因・対処を追記して育てること。
なお Firefox は PDF を pdf.js で内蔵描画する等エンジンが違うため、Windows で確認した
ブラウザに Firefox が含まれていない場合は、機会があれば併せて確認しておきたい。

## この構成の参照実装（このリポジトリ内）

- CSP / 共通セキュリティヘッダ: `worker/lib/http.js`（`withSecurityHeaders`, CSP定数）
- PDF配信・トークン発行・フレーム許可: `worker/index.js`
  （`handleDownloadAttachment`, `handleAttachmentPreviewToken`）
- 署名トークン（HS256 / Web Crypto）: `worker/lib/jwt.js`
- フロントのプレビューURL生成: `src/lib/api.js`（`getAttachmentPreviewUrl`, `fetchAttachmentBlob`）
- プレビューUI・ズーム: `src/components/AttachmentPreview.jsx`, `src/components/TaskDetail.jsx`
- 経緯: `docs/HANDOFF.md`（経緯の要約 57〜59番）, 設計書 `docs/task-management-spec-cloudflare.md` 4-5章・8章

## 応用: 既存の保存済みファイルではなく「その場でクライアント生成したファイル」をプレビューする

上記の実装は Gmail 添付という**既にサーバー側（外部API）に存在するファイル**が前提だが、
同じ「短命トークン＋実URLへの`<iframe>`ナビゲーション」の型は、**jsPDFなどでブラウザ側が
その場で生成したファイル**（プレビューすべき実体がまだどこにも保存されていない）にもそのまま
応用できる。違いはトークン発行の前に一段階「アップロードして保存」が増える点だけ：

1. クライアントは生成したファイル（PDFのBlob等）を `POST` でアップロードするだけの
   専用エンドポイントに送る。保存先は既存の一時保存先（写真バケット等）を流用してよく、
   キーを**ユーザーごとに固定**して毎回上書き（upsert）すれば、削除処理を別途書かなくても
   ゴミが溜まらない。
2. サーバーはそのオブジェクトに紐づく短命トークン（1〜3分で十分。Gmail添付のケースと同じ
   `signJwt`/`verifyJwt`）を返す。
3. 以降は既存の型と同じ: `<iframe src="/preview?token=...">` へナビゲーションさせ、
   GETハンドラはトークンを検証してオブジェクトを`Content-Disposition: inline`で返し、
   そのレスポンスだけ`X-Frame-Options: SAMEORIGIN`/CSP `frame-ancestors 'self'`に緩める。

参照実装（2026-08-07・自主検査表PDFのアプリ内プレビュー化）:
- アップロード＋トークン発行・配信: `worker/lib/reports.js`
  （`handleInspectionPdfPreviewCreate`, `handleInspectionPdfPreviewGet`）
- 一時保存（ユーザーごとに固定キーでupsert、溜め込まない）: `worker/lib/storage.js`（`putObject`の`upsert`オプション）
- フロントのプレビューURL生成: `src/lib/reports.js`（`getInspectionPdfPreviewUrl`）
- プレビューUI: 既存の`AttachmentPreview.jsx`をそのまま再利用（`headerAction` propで
  「共有 / 保存」ボタンを追加注入。既存の添付ファイル用途は無変更）
- 経緯・関連するiOS standalone PWA特有の罠（`jsPDF.save()`が閉じた後に白画面になる問題）は
  プロジェクトスキル `print-and-pdf-download` の Gotcha 8 を参照
