# タスク管理システム 設計書（Cloudflare 版）

最終更新: 2026-07-15
対象: 本番稼働中の現行システム（https://task-management.eiwa-public.workers.dev）

> 旧設計書 `task-management-spec.md`（Netlify 版）は初期計画の記録として残す。
> 本書が現行の正であり、両者が食い違う場合は本書に従う。

---

## 1. プロジェクト概要

### 背景と目的

- 有限会社 栄和の社員3名が共有 Gmail アカウント（eiwa.public@gmail.com）で業務メールを受信している
- Gmail から業務メールを自動取得し、AI（Claude API）で「業務判定・担当者振り分け・期限抽出・送信元抽出」を行い、カンバン形式で進捗管理できる社内 Web アプリ
- 当初 Netlify で構築予定だったが無料枠を消費したため、**Cloudflare Workers（無料プラン）に移行**して構築した

### 運用方針

- 開発〜運用は原則すべて無料枠内。実費は Claude API（claude-haiku-4-5）の従量課金のみ（月数百円規模）
- デプロイは GitHub の main ブランチへの push で全自動

---

## 2. 技術スタック

| 役割 | 採用技術 | 備考 |
|------|----------|------|
| フロントエンド | React 19 (Vite) | カンバン UI / 設定画面 / SPA |
| バックエンド | Cloudflare Workers（単一 Worker） | 静的配信 + API + Cron を1つで担う |
| DB | Supabase (PostgreSQL) | プロジェクト: Eiwapublic Project (`pfiogfdnbctunkhslmcp`) |
| 定期実行 | Cloudflare Cron Triggers | `*/5 * * * *`（5分ごとに起動、実処理は設定でゲート） |
| メール取得 | Gmail API (OAuth 2.0 リフレッシュトークン) | scope: gmail.readonly |
| AI 処理 | Claude API (`claude-haiku-4-5`) | 環境変数 `CLAUDE_MODEL` で変更可 |
| 認証 | カスタム認証（bcrypt + HS256 JWT） | JWT は Web Crypto による自前実装。有効期限30日 |
| PWA | 自前の最小 Service Worker（キャッシュなし） | 更新通知バナー・ロゴタップ最新化。ビルド時に `public/sw.js` を生成 |
| CI/CD | GitHub Actions + wrangler-action | main への push で自動デプロイ |

### Netlify 版からの主な変更点

| 項目 | Netlify 版（旧） | Cloudflare 版（現行） |
|---|---|---|
| API | netlify/functions の個別関数 | `worker/index.js` の単一 Worker でルーティング |
| 定期実行 | Scheduled Functions | Cron Triggers（`wrangler.jsonc`） |
| SPA フォールバック | netlify.toml の redirects | `assets.not_found_handling: "single-page-application"` |
| JWT | `jsonwebtoken`（Node 依存） | Web Crypto 自前実装（`worker/lib/jwt.js`） |
| デプロイ | Netlify Git 連携 | GitHub Actions（deploy → secrets 同期の2段階） |

---

## 3. リポジトリ構成

```
worker/
├── index.js            Worker 本体（fetch: /api/* ルーティング＋静的配信 / scheduled: Cron）
└── lib/
    ├── pipeline.js     取得〜分類〜保存〜返信検知〜利用量集計の一括パイプライン
    ├── gmail.js        Gmail API 軽量クライアント（fetch 直叩き・依存なし。スレッド取得・添付一覧/取得を含む）
    ├── mail-utils.js   アドレス判定・顧客(counterpart)特定の共通ロジック（返信検知と添付集約で共有）
    ├── calendar.js     Google カレンダー API クライアント（当日イベント取得）
    ├── anthropic.js    Claude API クライアント（分類プロンプト・JSON抽出・課金エラー検知）
    ├── supabase-admin.js  service role クライアント（URL不正時はフォールバック）
    ├── jwt.js          HS256 JWT の署名・検証（Web Crypto）
    └── http.js         JSONレスポンス・Bearer トークン検証ヘルパー
src/
├── pages/              Login / Dashboard（カンバン）/ Settings / Logs
├── components/         KanbanBoard, KanbanColumn, TaskCard, TaskDetail,
│                       TaskForm, FilterBar, SettingsPanel, UsagePanel
├── pwa/                ReloadPrompt.jsx（更新バナー）, reloadApp.js（ロゴタップ最新化）
└── lib/                supabase(anon), auth, api, tasks, format, status, pricing,
                        mail, version（ビルド時刻表示）
scripts/
└── generate-sw.mjs     ビルド時に public/sw.js を生成（SW_VERSION=git SHA を刻印）
public/
├── logo.svg            栄和ロゴ（原本 logo_black.svg を赤 #c81021 で塗ったもの）
├── logo_black.svg      ロゴ原本（枠線のみ）
├── manifest.webmanifest  PWA マニフェスト
└── sw.js               ★ビルド生成物（gitignore）。最小 Service Worker
supabase/schema.sql     DB スキーマ（IaC。SQL Editor / migration で適用）
wrangler.jsonc          Worker 設定（assets / cron / nodejs_compat）
.github/workflows/
├── deploy.yml          main push → ビルド → デプロイ → シークレット同期
└── cleanup-worker.yml  不要 Worker の手動削除（workflow_dispatch）
docs/                   本書・引き継ぎ書・旧設計書
```

---

## 4. 機能仕様

### 4-1. メール自動取得・分類パイプライン（`worker/lib/pipeline.js`）

Cron（5分ごと）または「今すぐ取得」（force=true）で起動し、以下を順に実行する。

1. **稼働時間帯ゲート**（force 時はスキップ）: JST の現在時刻が `active_hours_start`〜`active_hours_end`（既定 8〜18時）の範囲外なら処理をスキップ
2. **更新間隔ゲート**（force 時はスキップ）: 前回取得から `fetch_interval_minutes`（既定30分）未満ならスキップ
3. Gmail から新着メールを取得（初回は直近1日分、以降は `last_fetch_at` 以降。1回の上限 40 通）
4. 既に tasks に存在するスレッドはスキップ。新規メールを Claude API で分類:
   - `is_business_task`: 業務メールか否か（広告・通知・営業は false）
   - `assignee`: 担当者（settings の3名から。不明・範囲外は「（担当未設定）」にして画面でオレンジ警告）
   - `due_date`: 期限（「来週末」等の相対表現も JST 基準で YYYY-MM-DD に変換）
   - `title`: タスクタイトル（30字以内で自動生成）
   - `sender_display`: 送信元の会社名・氏名（**問い合わせフォーム経由は本文の記載を優先**）
   - `sender_email`: 返信先メールアドレス（フォーム経由は本文記載のアドレスを優先。取れない場合は Reply-To → From にフォールバック）
   - `reason`: 判定理由（振り分けルール調整の参考用に保存）
5. 業務メールのみ tasks に INSERT（ステータス「未処理」）
6. **返信検知**（2方式。「未処理」タスクに加えて「返信済み」タスクも対象にする）:
   - **件名ベース**: 受信メールの件名（Re: 等を除去して正規化）が対象タスクと一致し、差出人が自社側（共有アドレス or `company_domains` のドメイン）かつ宛先が元の顧客（counterpart）なら返信とみなす（Claude 分類はスキップ＝コスト節約）。担当者が自分のメーラーから返信し CC の社内 ML 経由で共有アドレスに配信されたケースを拾う
   - **スレッドベース**: タスクのスレッドを読み、**スレッド内で最も新しい「自社発」メッセージ**を返信とみなす。顧客が受領返信を最後に送っていても、担当者（自社）の最新の更新返信を採用できる。宛先(To/Cc)に顧客(counterpart)を含むメッセージだけを対象にし、同一件名で複数顧客が1スレッドにまとまった場合の混線を防ぐ
   - **顧客(counterpart)の特定**: 受信メール由来のタスク（sender が顧客）は送信者を顧客とする。**自社発信由来のタスク**（自社→社外送信で「返信済み」登録＝sender が自社）は、元メッセージの宛先(To/Cc)のうち自社以外を顧客とする。アドレス判定・counterpart 特定は `worker/lib/mail-utils.js` に共通化
   - **誤検知ガード**: タスク登録の元になったメッセージ自体は返信とみなさない（社内発・問い合わせフォームシステム発のメールは From が自社ドメインのため、宛先=顧客の条件と併せて返信ゼロでの誤検知を防ぐ）
   - **本文の上書き**: 返信検知時は、タスクの本文プレビューを**返信の本文全体で置き換える**。未処理→返信済みの初回検知だけでなく、既に返信済みのタスクにさらに新しい返信が来た場合も本文を最新の内容で上書きする（ステータスは返信済みのまま「AI判定の理由」に更新記録を追記）。冪等化のため、取り込んだ返信の message id を `tasks.last_reply_message_id` に記録し、同じ返信の再適用を避ける
   - **本文の整形**: HTMLメールはブロック要素を改行に変換して**改行を保持**（横方向の空白のみ圧縮）。引用された過去のやり取り（初回発信メールまで）を含む全文を残すため、`body_preview` の保存上限は **20000字**（`MAX_BODY_PREVIEW`）。行頭引用マーク（>/＞）と不可視文字は除去し、連続する空行は1つに圧縮
6.5. **Google カレンダー取込**: `calendar_name` で指定したカレンダーの**当日イベント**を取得し、未登録のものをタスク化（source='calendar'、ステータス「未処理」）。イベントのタイトル・詳細をそのまま登録し、詳細に「担当：〜」（「担当者：」も可）があればその担当者を割り当てる（無ければ既定担当）。カレンダー由来タスクは返信検知の対象外・タスク詳細のメール参照/返信ボタンも非表示。Gmail と同じ OAuth トークンを使うため、トークンに `calendar.readonly` スコープが必要
   - `calendar_name` は**表示名**（calendarList から解決）または**カレンダーID**（`@` を含む値は ID 直接指定）のどちらでも指定可。表示名で解決できない場合は利用可能なカレンダー名を操作ログに出す
   - 本番では ID 直接指定を採用（値: `eiwa.public@gmail.com`）。理由は下記の実装ノート参照
7. **利用量集計**: Claude のトークン使用量を api_usage に月次加算（推定コスト表示用）
8. **クレジット監視**: Claude API が残高不足エラーを返したら `api_credit_alert` を設定（正常分類で自動解除）。ダッシュボードに警告バナー＋チャージ導線を表示
9. `last_fetch_at` を現在時刻に更新

### 4-2. タスクのステータス管理

```
未処理 → 返信済み / 対応中 → 完了
```

| ステータス | 遷移条件 |
|-----------|---------|
| 未処理 | 新規登録時の初期状態 |
| 返信済み | 共有 Gmail からの返信を検知して自動遷移（未処理のみ対象） |
| 対応中 / 完了 | 担当者が手動で変更（ドラッグ＆ドロップ or 詳細画面のボタン） |

### 4-3. 画面仕様

**共通**: ヘッダーは落ち着いたグリーン（#33604d）。左上に栄和ロゴ（白円台座）。ヘッダー内のボタンは高さ36pxで統一。

**ログイン画面**: ロゴ + 「栄和　タスク管理システム」。ユーザー名/パスワード認証。

**メイン画面（カンバン）**:
- タイトル「栄和　タスク管理システム」(22px)。右側に「今すぐ取得」（白）「ログ」（白）「設定」（青）「ログアウト」（黒）
- **レスポンシブ / モバイル対応**: 幅 768px 以下ではヘッダーの操作ボタンを右上の**3本線（ハンバーガー）メニュー**に畳む（開くと最終取得時刻＋各操作を縦並び。外側クリック/Esc で閉じる）。カンバン列は横スクロール、タスク詳細モーダルは1カラム化。入力欄はモバイルで16pxにして iOS のフォーカス時ズームを抑止。デスクトップの見た目は不変。関連 CSS は `Dashboard.css` / `KanbanBoard.css` 等の `@media` 、開閉ロジックは `Dashboard.jsx`
- ログインユーザー名は担当者フィルターと同じ行の右端に大きめ（17px）に表示
- 4列カンバン（列背景はステータス色を薄く混ぜた濃いめの色）。ステータス名 16px
- タスクカード: タイトル / 送信元（👤 会社名・氏名。旧データは From 表示名で代替）/ 担当者アバター / 期限（超過・間近バッジ）/ 受信日時 / 件名（折りたたみ）
- 未処理列のヘッダーに新規タスク手動登録の「＋」ボタン（**青地＋白文字**で強調）
- 担当者フィルター（チップ、15px）。ドラッグ＆ドロップでステータス変更（anon キーは status 列のみ更新可）
- タスク詳細モーダル（幅820px・視認性重視で文字は大きめ）: タイトル+×は固定ヘッダー、最下部は固定フッタ。フッタ左に「ステータス」見出し＋変更ボタン、右に「メール参照」「返信」ボタン
  - 担当者・期限・留意事項（remarks）は詳細画面で編集し「保存」（`PATCH /api/tasks`）。担当者が「（担当未設定）」のときはオレンジで警告
  - **添付ファイル**（メール由来タスクのみ）: 開いた時に**スレッド全体**の添付一覧を Gmail から取得（対象顧客宛メッセージのみ・別顧客分は除外）。ありなら「📎 添付あり」バッジ＋ファイル名・サイズ・[ダウンロード]ボタンを表示。返信で本文が上書きされても最初・途中の添付は残る。ダウンロードは Worker 経由で取得（後述 4-5）
  - **メール参照**: Gmail のウェブ画面で該当メールを開く（`https://mail.google.com/mail/?authuser=<共有アドレス>#all/<gmail_message_id>`。パスに `/u/<アドレス>` を埋め込む形式は 404 になることがあるため authuser クエリを使う。共有アカウントへのログインが必要）
  - **返信**: `mailto:` でメーラーの返信画面を開く。TO=タスクの返信先アドレス（フォーム経由は本文記載のアドレス）、CC=`if@eiwa-up.jp`（固定。同アドレス宛は共有 Gmail にも配信されるため返信検知の対象になる）、本文に元メールを引用
- クレジット不足時は警告バナー＋「APIクレジットをチャージ」ボタン
- **アプリ更新バナー**（PWA）: 新バージョン検知時に画面上部へ「新しいバージョンがあります → 更新」を表示（後述 4-6）
- ヘッダー左のロゴはタップで最新化ボタンを兼ねる。ロゴ横に `ver.YYYY-MM-DD HH:MM`（ビルド時刻・JST）を表示

**操作ログ画面（/logs）**:
- ヘッダー「操作ログ」+「×」（カンバンへ戻る）。ヘッダーの「ログ」ボタン（メイン画面）から遷移
- 直近200件を表形式で表示: 日時 / 種別（メール取得・ステータス変更）/ 実行者 / 内容
- 実行者は担当者の表示名（手動操作）または「システム（自動）」（Cron 実行・返信自動検知）

**設定画面**:
- ヘッダー右: 保存メッセージ /「Anthropic API 支払設定」（赤）/「保存」（青）/「×」（保存せずカンバンへ戻る）
- 2カラム。左: 「更新頻度と時間帯」（開始時・終了時・頻度分を1行）/ 担当者名3名 / 業務判定キーワード。右: 業務背景・振り分けルール（org_context、大きな入力欄）
- 下部: 「今月の Anthropic API 利用状況」（対象月・分類件数・入出力トークン・推定コストを1行表示）、最下部に試算の注釈

### 4-4. API エンドポイント（Worker）

| メソッド/パス | 認証 | 内容 |
|---|---|---|
| POST `/api/login` | 不要 | bcrypt 照合 → HS256 JWT（**30日**有効）を発行 |
| POST `/api/run-fetch` | JWT | パイプラインを force=true で即時実行 |
| PUT `/api/settings` | JWT | 許可キーのみ settings に upsert（service role 経由） |
| POST `/api/tasks` | JWT | タスクの手動登録（`source='manual'`、id は `manual:<uuid>`） |
| PATCH `/api/tasks` | JWT | `assignee` / `due_date` / `remarks` / `title` を更新（service role 経由） |
| GET `/api/attachments` | JWT | `thread_id=…` でスレッド全体の添付一覧（ファイル名/MIME/サイズ/attachmentId/所属 message_id）を集約して返す。対象タスクの顧客宛メッセージのみに絞り込み。`message_id=…` の単一メッセージ指定にも後方互換 |
| GET `/api/attachment` | JWT | 添付本体を返す（`Content-Disposition: attachment`、日本語名は RFC5987 併記） |
| その他 | — | dist/ の静的アセット（SPA フォールバック） |

- 認証必須 API は `Authorization: Bearer <JWT>` を要求。**トークン期限切れ（401）時はフロントが自動ログアウトして `/login?expired=1` へ誘導**（`authFetch`）。カンバンのステータス変更は Supabase 直結（anon）で Worker を通らない点に注意
- settings の許可キー: `fetch_interval_minutes`, `active_hours_start`, `active_hours_end`, `assignees`, `business_keywords`, `org_context`, `shared_gmail`, `company_domains`, `calendar_name`

> **実装ノート（カレンダーIDの扱い）**: 「栄和共通」は独立した副カレンダーではなく、共有アカウント `eiwa.public@gmail.com` の**メイン（デフォルト）カレンダーに付けた表示名**だった。メインカレンダーの ID はアカウントのメールアドレスそのもの（`eiwa.public@gmail.com`）であり、`calendarList.list` では表示名ではなくメールアドレス名で返るため「栄和共通」という名前では解決できなかった。このため `calendar_name` にカレンダーID（`eiwa.public@gmail.com`）を直接指定する運用にしている。

### 4-5. 添付ファイル表示・ダウンロード

- メール由来タスクの詳細画面を開くと、`GET /api/attachments?thread_id=…` で**スレッド全体の添付一覧をその場で Gmail から取得**して表示する（`gmail.js` が各メッセージの payload を再帰的に辿り、`filename` と `body.attachmentId` を持つパートを抽出。署名等に埋め込まれたインライン画像 = `Content-Disposition: inline` の image/* は除外）。
- **スレッド集約**: 返信で本文が上書きされても最初・途中の返信の添付が失われないよう、スレッド内の全メッセージの添付を集約する（同一ファイル=名前+サイズ+MIME は1件に集約）。ただし同一件名で複数顧客が1スレッドにまとまる場合に別顧客宛の添付が混ざるのを防ぐため、**対象タスクの顧客(counterpart)が参加している（From/To/Cc に含む）メッセージの添付だけ**に絞り込む（counterpart は `mail-utils.js` で特定）。各添付は所属 `messageId` を持ち、ダウンロード時に使う。
- 各ファイルの [ダウンロード] は `GET /api/attachment` を叩き、Worker が Gmail の `messages/{id}/attachments/{attachmentId}` から本体（base64url）を取得してバイト列で返す。フロントは Bearer 付き fetch → Blob 化してダウンロードを起動する。
- **設計判断**: 添付メタ情報を DB に持たせず取得のたびに Gmail へ問い合わせる方式にした。理由は (1) 既存タスクにも追加改修なしで対応できる、(2) メール取得パイプライン・スキーマに手を入れずリスクを抑えられる、(3) 共有アカウントの認証情報で取得するので担当者個人の Gmail ログインが不要。既存の `gmail.readonly` スコープで動作する。

### 4-6. PWA（アプリ更新の通知・明示的な最新化）

別プロジェクトのスキル `pwa-auto-update` を Vite + React 向けに移植して適用。**キャッシュを一切行わない最小 Service Worker**を採用しているのが要点。

- **Service Worker（`public/sw.js`。`scripts/generate-sw.mjs` がビルド時に生成）**: `fetch` ハンドラを持たず、リクエストを横取りしない。役割は「更新の検知」と「`SKIP_WAITING` による有効化」のみ。`SW_VERSION`（git SHA）を刻印し、デプロイごとに内容が変わることでブラウザが新版を検知する。`activate` 時に旧キャッシュを掃除し `clients.claim()`。
  - ※ キャッシュ型 SW（`vite-plugin-pwa`/Workbox 等）は Cloudflare 環境でナビゲーション/RSC を横取りして遷移を壊す事例があるため**採用しない**。この SW に fetch/キャッシュ処理を足さないこと。
- **更新バナー（`src/pwa/ReloadPrompt.jsx`）**: 新版検知時に画面上部へ「新しいバージョンがあります → 更新」を表示。約1分間隔で `registration.update()` をポーリング。更新ボタン押下で `SKIP_WAITING` を送り、「更新中…」表示を約0.8秒見せてからリロード（クリックを明確に認知させるため）。本番ビルドのみ描画（`import.meta.env.PROD`）。初回インストール時は自動リロードしないガードあり。
- **ロゴタップ最新化（`src/pwa/reloadApp.js`）**: ダッシュボード左上のロゴがボタンを兼ね、待機中の新 SW があれば有効化してリロード（iOS 向けの保険タイマー付き）。
- **表示用バージョン（`src/lib/version.js`）**: `vite.config.js` の `define` でビルド時刻を `__BUILD_TIME__` に埋め込み、ヘッダーに `ver.YYYY-MM-DD HH:MM`（JST）を表示。端末が最新デプロイを取得できているかの確認用（更新“検知”は SW_VERSION が担い、この表示値とは独立）。
- **マニフェスト（`public/manifest.webmanifest`）**: ホーム画面追加用。theme_color=#33604d。`index.html` に manifest link・apple-touch-icon・`viewport-fit=cover` を追加。
- `npm run build` は `node scripts/generate-sw.mjs && vite build`。`public/sw.js` は生成物のため gitignore。

---

## 5. データベース設計（Supabase）

スキーマの正は `supabase/schema.sql`。適用済みの構成:

### tasks
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| gmail_thread_id | text unique | スレッド識別子（重複取込防止） |
| gmail_message_id | text | |
| title | text | AI 生成タイトル |
| assignee | text | 担当者名 |
| status | text | 未処理/返信済み/対応中/完了（CHECK 制約） |
| due_date | date | null 可 |
| sender | text | From ヘッダー |
| sender_display | text | AI 抽出の会社名・氏名（フォーム経由は本文優先） |
| sender_email | text | 返信先アドレス（フォーム経由は本文記載を優先） |
| source | text | 取得元。`email`（Gmail）/ `calendar`（Google カレンダー）。既定 email |
| subject / body_preview | text | body_preview は先頭 20000字（`MAX_BODY_PREVIEW`。引用履歴を含む全文を保持。改行も保持） |
| remarks | text | 留意事項。詳細画面で手動入力（マイグレーション `add_remarks_to_tasks`） |
| last_reply_message_id | text | 最後に取り込んだ返信の Gmail message id。返信検知の冪等化用（マイグレーション `add_last_reply_message_id_to_tasks`。NULL 可） |
| classification_note | text | AI の判定理由 |
| received_at / created_at / updated_at | timestamptz | updated_at はトリガーで自動更新 |

> 添付ファイルは DB に保持しない（詳細画面を開くたびに Gmail から取得。4-5 参照）。手動登録タスクは `source='manual'`、`gmail_thread_id`/`gmail_message_id` が `manual:<uuid>`。

### settings（key/value）
`fetch_interval_minutes`(30), `active_hours_start`(8), `active_hours_end`(18), `assignees`(["橋口","西川","岡田"]), `business_keywords`, `org_context`, `shared_gmail`(eiwa.public@gmail.com), `company_domains`(eiwa-up.jp。自社ドメイン、カンマ区切り), `api_credit_alert`, `last_fetch_at`

### users
id / username(unique) / password_hash(bcrypt) / display_name / created_at。**anon からは一切アクセス不可（service role のみ）**

### api_usage
month(PK, 'YYYY-MM') / input_tokens / output_tokens / calls / updated_at。`add_api_usage()` 関数（service role 専用）で原子的に加算

### activity_logs（操作ログ）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| log_type | text | `fetch`（メール取得の実行結果） / `status_change`（ステータス変更） |
| actor | text | 実行者。担当者の表示名、または「システム（自動）」 |
| message | text | 画面表示用の内容 |
| detail | jsonb | 取得サマリー等の生データ |
| created_at | timestamptz | |

書き込み元: パイプライン（取得結果 + 返信検知の自動ステータス変更 = service role）、フロントエンド（担当者の手動ステータス変更 = anon INSERT）。60日より古いログはパイプライン実行時に自動削除。画面 `/logs`（操作ログ）で直近200件を参照。

### RLS / 権限設計
- tasks・settings・api_usage: anon は SELECT 可。tasks は **status 列のみ** anon が UPDATE 可（列レベル GRANT）
- activity_logs: anon は SELECT / INSERT 可（UPDATE / DELETE は service role のみ）
- INSERT / DELETE / その他の列更新・users への操作は service role（Worker）経由に限定

---

## 6. 環境変数・シークレット

### Worker シークレット（GitHub Secrets からデプロイ時に自動同期）
| 名前 | 用途 |
|---|---|
| SUPABASE_URL / SUPABASE_SERVICE_KEY | service role 接続（URL は不正時にコード内の既知値へフォールバック） |
| SESSION_SECRET | JWT 署名鍵 |
| ANTHROPIC_API_KEY | Claude API |
| GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN | Gmail OAuth |

### ビルド時（フロントエンド埋め込み・公開値）
| 名前 | 備考 |
|---|---|
| VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY | 未設定・不正な URL の場合はコード内の本番公開値にフォールバック（`src/lib/supabase.js`） |

### CI 用
CLOUDFLARE_API_TOKEN（テンプレート「Edit Cloudflare Workers」）/ CLOUDFLARE_ACCOUNT_ID

---

## 7. デプロイ・CI/CD

- main へ push → `.github/workflows/deploy.yml` が起動:
  1. `npm ci` → `npm run build`（VITE_* を埋め込み）
  2. **wrangler deploy**（Worker + 静的アセット + Cron）
  3. **シークレット同期**（デプロイ後に実行）
- 手動実行: Actions タブ →「Deploy to Cloudflare Workers」→ Run workflow
- 設計上の注意（過去の障害から）:
  - デプロイ→シークレットの**2段階**にしてある。1ステップにまとめると、未デプロイの新バージョンが残った際に error 10215 で自己復旧できなくなる
  - `concurrency.cancel-in-progress` は **false**。途中キャンセルが上記の不整合を作るため
- 不要 Worker の削除: Actions →「Delete Cloudflare Worker」で Worker 名を指定して実行

---

## 8. セキュリティ

- service role キー・API キー類は Worker シークレットのみに保持し、フロントエンドへは渡さない
- フロントエンドは anon キー + RLS（読み取りと status 更新のみ）
- ログインは bcrypt ハッシュ照合。ユーザー不在とパスワード不一致は同一メッセージ（存在推測の防止）
- JWT は HS256・**30日**有効。サーバー側で署名検証、クライアント側は exp による自動ログアウト。加えて認証必須 API が 401 を返したらフロントが即ログアウトしてログイン画面へ誘導する
- 添付ファイル API はログイン必須。共有アカウントの Gmail 認証情報（readonly）で取得し、フロントには渡さない
- Gmail は readonly スコープ。HTTPS は Cloudflare が終端

---

## 9. コスト・無料枠

| サービス | 無料枠 | 利用見込み |
|---|---|---|
| Cloudflare Workers | 10万リクエスト/日・Cron 可・静的配信は無課金 | 社内3名 + Cron 288回/日 → 余裕で枠内 |
| Supabase | 500MB DB | テキストのみで枠内 |
| Gmail API | 無料 | — |
| Claude API (haiku) | 従量課金 | 1通あたり約0.3円。購入済み $5 で数か月分 |

- 稼働時間帯設定により時間外の起動を停止（Claude 費用はメール数比例のため総額はほぼ不変だが、無駄な実行を削減）
- 設定画面の「今月の Anthropic API 利用状況」で自前計測ベースの推定コストを常時確認可能
- 残高不足は自動検知し、ダッシュボードに警告＋チャージ導線を表示
