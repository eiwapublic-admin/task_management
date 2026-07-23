# タスク管理システム 設計書（Cloudflare 版）

最終更新: 2026-07-21
対象: 本番稼働中の現行システム（https://task-management.eiwa-public.workers.dev）
リポジトリ: `eiwapublic-admin/task_management`（**非公開（Private）**。2026-07-16 にPrivate化）

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
    └── http.js         JSONレスポンス・Bearer トークン検証（token_version失効チェック込み）・
                        全レスポンス共通のセキュリティヘッダ付与（withSecurityHeaders）
src/
├── pages/              Login / Dashboard（カンバン）/ Settings / Usage（従量課金事項）/
│                       Logs（処理ログ）/ Archive（アーカイブ）
├── components/         AppHeader（全画面共通ヘッダー）, KanbanBoard, KanbanColumn, TaskCard,
│                       TaskDetail, TaskForm, FilterBar, SettingsPanel, UsagePanel, AboutModal
├── pwa/                ReloadPrompt.jsx（更新バナー）, reloadApp.js（ロゴタップ最新化）
└── lib/                auth, api（authFetch）, tasks（Worker API経由）, format, status,
                        pricing, mail, version（ビルド時刻表示）, channel（情報源アイコン解決）
scripts/
└── generate-sw.mjs     ビルド時に public/sw.js を生成（SW_VERSION=git SHA を刻印）
public/
├── logo.svg            栄和ロゴ（原本 logo_black.svg を赤 #c81021 で塗ったもの）
├── logo_black.svg      ロゴ原本（枠線のみ）
├── manifest.webmanifest  PWA マニフェスト
├── system-overview.png  「このシステムについて」モーダルで表示するシステム構成図
├── icons/              情報源アイコン画像（mail_icon.png / globe_icon.png / calendar_icon.png /
│                       fax_icon.png / pen_icon.png。2026-07-17〜）
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
   - `contact`: 先方担当者の宛名「会社・氏名＋様」（返信メール冒頭・詳細画面の表示に使う。取れなければ保存時に `sender_display`＋様 でフォールバック）
   - `sender_email`: 返信先メールアドレス（フォーム経由は本文記載のアドレスを優先。取れない場合は Reply-To → From にフォールバック）
   - `document_summary`: 添付のPDF・画像（FAX転送メールを含む）から読み取った内容の要約（顧客・資料の件名・金額/数量/納期等の要点）。添付が無い/読み取れない場合は null
   - `channel`: 経路種別 `email`（通常メール）/ `form`（問い合わせフォーム）/ `fax`（FAX転送メール）。カード・詳細画面のアイコン表示に使う（source とは独立）
   - `reason`: 判定理由（振り分けルール調整の参考用に保存）
   - **添付（PDF・画像）の読み取り**: 対応形式（PDF・PNG・JPEG・GIF・WebP、1ファイル10MB・合計12MB・最大5件まで）の添付があれば、本文と一緒に Claude へ渡して読み取らせる。FAX転送メール（件名「Attached Image」等・本文ほぼ無し）はこれが無いと内容を判定できないため必須。詳細は 4-7 参照
5. 業務メールのみ tasks に INSERT（ステータス「未処理」）。`document_summary` があれば `body_preview` に反映（本文が薄いFAXは要約がそのまま本文に、通常メールは本文の後ろに追記）
6. **返信検知**（3方式。「未処理」タスクに加えて「返信済み」タスクも対象にする）:
   - **件名ベース**: 受信メールの件名（Re: 等を除去して正規化）が対象タスクと一致し、差出人が自社側（共有アドレス or `company_domains` のドメイン）かつ宛先が元の顧客（counterpart）なら返信とみなす（Claude 分類はスキップ＝コスト節約）。担当者が自分のメーラーから返信し CC の社内 ML 経由で共有アドレスに配信されたケースを拾う
   - **スレッドベース**: タスクのスレッドを読み、**スレッド内で最も新しい「自社発」メッセージ**を返信とみなす。顧客が受領返信を最後に送っていても、担当者（自社）の最新の更新返信を採用できる。宛先(To/Cc)に顧客(counterpart)を含むメッセージだけを対象にし、同一件名で複数顧客が1スレッドにまとまった場合の混線を防ぐ
   - **顧客メールアドレスベース（フォームタスク限定。2026-07-21追加）**: `channel='form'` の未処理タスクは、問い合わせフォームの自動送信メールの件名が全顧客共通の定型文（例:「ホームページからのお問い合わせ」）のため、件名ベース検知が機能しない。代わりに、自社側から**フォーム本文に記載された顧客の実メールアドレス（`sender_email`）宛**に送られたメールを返信とみなす（新規スレッド・件名でも検知できる）。同じ顧客メールアドレスに複数の未処理フォームタスクがある場合は、新しいメールの件名・本文とタスクタイトルのキーワード（カタカナ・漢字・英数字の塊。「見積」等の定型語は除外）の一致で1件に絞り込み、絞り込めない（一致なし、または複数タスクで同点）ときは自動判定を見送る（誤って別件に結び付けない）。実装は `worker/lib/pipeline.js` の `openFormByEmail` / `pickFormReplyTarget`
   - **顧客(counterpart)の特定**: 受信メール由来のタスク（sender が顧客）は送信者を顧客とする。**自社発信由来のタスク**（自社→社外送信で「返信済み」登録＝sender が自社）は、元メッセージの宛先(To/Cc)のうち自社以外を顧客とする。アドレス判定・counterpart 特定は `worker/lib/mail-utils.js` に共通化
   - **誤検知ガード**: タスク登録の元になったメッセージ自体は返信とみなさない（社内発・問い合わせフォームシステム発のメールは From が自社ドメインのため、宛先=顧客の条件と併せて返信ゼロでの誤検知を防ぐ）
   - **本文の上書き**: 返信検知時は、タスクの本文プレビューを**返信の本文全体で置き換える**。未処理→返信済みの初回検知だけでなく、既に返信済みのタスクにさらに新しい返信が来た場合も本文を最新の内容で上書きする（ステータスは返信済みのまま「AI判定の理由」に更新記録を追記）。冪等化のため、取り込んだ返信の message id を `tasks.last_reply_message_id` に記録し、同じ返信の再適用を避ける
   - **本文の整形**: HTMLメールはブロック要素を改行に変換して**改行を保持**（横方向の空白のみ圧縮）。引用された過去のやり取り（初回発信メールまで）を含む全文を残すため、`body_preview` の保存上限は **20000字**（`MAX_BODY_PREVIEW`）。行頭引用マーク（>/＞）と不可視文字は除去し、連続する空行は1つに圧縮
6.5. **Google カレンダー取込**: `calendar_name` で指定したカレンダーの**当日イベント**を取得し、未登録のものをタスク化（source='calendar'、ステータス「未処理」）。イベントのタイトル・詳細をそのまま登録し、詳細に「担当：〜」（「担当者：」も可）があればその担当者を割り当てる（無ければ既定担当）。カレンダー由来タスクは返信検知の対象外・タスク詳細のメール参照/返信ボタンも非表示。Gmail と同じ OAuth トークンを使うため、トークンに `calendar.readonly` スコープが必要
   - `calendar_name` は**表示名**（calendarList から解決）または**カレンダーID**（`@` を含む値は ID 直接指定）のどちらでも指定可。表示名で解決できない場合は利用可能なカレンダー名を操作ログに出す
   - 本番では ID 直接指定を採用（値: `eiwa.public@gmail.com`）。理由は下記の実装ノート参照
7. **利用量集計**: Claude のトークン使用量を api_usage に月次加算（推定コスト表示用）
8. **完了タスクのアーカイブ**: ステータス「完了」になってから `archive_after_days`（既定30。0で無効）を超えたタスクを `archived_at` にセットしてアーカイブへ移す（カンバンの完了列に溜まり続けないようにする。アーカイブ画面で参照）。`completed_at` を持たない旧データは対象外
9. **クレジット監視**: Claude API が残高不足エラーを返したら `api_credit_alert` を設定（正常分類で自動解除）。ダッシュボードに警告バナー＋チャージ導線を表示
10. `last_fetch_at` を現在時刻に更新

### 4-2. タスクのステータス管理

```
未処理 → 返信済み / 対応中 → 完了
```

| ステータス | 遷移条件 |
|-----------|---------|
| 未処理 | 新規登録時の初期状態 |
| 返信済み | 共有 Gmail からの返信を検知して自動遷移（未処理のみ対象） |
| 対応中 / 完了 | 担当者が手動で変更（ドラッグ＆ドロップ or 詳細画面のボタン） |

「完了」への遷移時に `completed_at` を記録し、これがアーカイブ移行の起点になる。完了以外へ戻すと `completed_at`・`archived_at` をクリアしてカンバンへ復帰させる（詳細は 4-8 アーカイブ）。

### 4-3. 画面仕様

**共通ヘッダー（`src/components/AppHeader.jsx`。2026-07-17に共通化）**: 全画面（メイン/設定/従量課金事項/処理ログ/アーカイブ）で同一のヘッダーコンポーネントを使う。落ち着いたグリーン（#33604d）。左に栄和ロゴ（タップで最新化。後述4-6）＋タイトル「栄和　タスク管理システム」(22px)＋ビルド時刻。右に**ログインユーザー名**（「○○ さん」）と**常時3本線（ハンバーガー）メニュー**（画面幅によらず）。各画面固有の「×で閉じる」ボタンは無く、ハンバーガーメニューから自由に行き来する。
- **ハンバーガーメニュー**（上から順に）: メイン / アーカイブ / 設定 / 従量課金事項 / 処理ログ / （区切り線）/ **今すぐ取得** / このシステムについて / ログアウト。各項目は白背景で統一。外側クリック/Esc で閉じる
  - **「今すぐ取得」のメニュー内移動（2026-07-21）**: 画面上部ツールバーにあった「今すぐ取得」ボタンを廃止し、ハンバーガーメニュー内の「処理ログ」の下（区切り線あり）へ移動。取得処理自体は`AppHeader.jsx`に内包し、完了後は`window.location.assign('/')`でトップへ強制遷移してタスク一覧を再取得させる（`AppHeader`は各ページで個別にマウントされ、メイン画面（Dashboard）のローカル状態に直接アクセスできないため）。これに伴い、取得完了時の件数内訳の通知バナー（`dashboard-notice`）は廃止
- **「このシステムについて」**: システム構成図（`public/system-overview.png`）を表示するモーダルを開く（`AboutModal.jsx`）
- **スクロールバーの見た目（2026-07-21）**: Windows/macOSのデスクトップブラウザ既定のオーバーレイ型スクロールバーは、ページのスタッキング（sticky固定のヘッダー等）とは無関係にOS/ブラウザのUI層で最前面に描画されるため、sticky固定ヘッダーに食い込んで見えることがある。`src/index.css` に常時表示の細いスクロールバーを自前描画するCSS（`scrollbar-gutter: stable` + `::-webkit-scrollbar` 系 + Firefox の `scrollbar-width`/`scrollbar-color`）を追加し、通常のスタッキング順に従わせることで解消した。全画面共通の対応（ページ個別のCSSではない）。**ただしSafariでは未解消**（Safariはメインページのスクロールを`::-webkit-scrollbar`等ではなくOS統合の表示（NSScroller）で描画する傾向が強く、ページ側CSSでの制御が効きにくい。業務に支障が無いためユーザー了承のもと対応保留）
- **iPhoneでヘッダーのタイトルが見えなくなる不具合への対策（2026-07-21）**: `.dashboard-header` に `env(safe-area-inset-top)` 分の上余白が無く、`viewport-fit=cover`＋ホーム画面追加（PWAスタンドアロン表示）時にノッチ/ステータスバー領域とヘッダー内容が重なっていた可能性を想定し、ヘッダーの上パディングに `env(safe-area-inset-top)` を追加（`TaskDetail`のオーバーレイや`ReloadPrompt.jsx`で既に採用済みの対策と同種）。**手元では実機の症状を再現できておらず、実機での解消は未確認**

**ログイン画面**: ロゴ + 「栄和　タスク管理システム」。ユーザー名/パスワード認証。

**情報源アイコン（`src/lib/channel.js`）**: メール📧/フォーム🌐/カレンダー📅/FAX📠/手入力✏️の5種を、カード・詳細画面・アーカイブ一覧のタイトル先頭に表示。**2026-07-17より絵文字から実画像（`public/icons/*.png`、`channelIconSrc()`）表示に変更**。カードは20px、詳細画面も20px（2026-07-18にカードを14px→20pxへ拡大し統一）。絵文字版（`channelIcon()`）は `<select><option>` 等、画像を使えない箇所向けに残置。`channel` は `email`/`form`/`fax`/`calendar`/`manual`（`task.channel` が無い旧データは `source` から補完）。

**メイン画面（カンバン）**:
- **レスポンシブ / モバイル対応**: 幅 768px 以下でもレイアウトは崩れない。カンバン列は横スクロール、タスク詳細モーダルは1カラム化。入力欄はモバイルで16pxにして iOS のフォーカス時ズームを抑止
  - **iPhoneでタスク詳細モーダルの上部（タイトル・×ボタン）が画面外に見切れてスクロールもできない不具合の修正（2026-07-21）**: iOS Safariはアドレスバーの表示/非表示で `vh` 単位の基準（実際に見えている高さ）が変わり、`position: fixed` のオーバーレイがアドレスバー分だけ実際の可視範囲より高く計算されることがある。対策: ① モーダルの `max-height` を `vh` に加えて `dvh`（動的ビューポート高さ。未対応ブラウザは無視され `vh` のまま）で指定し直す、② オーバーレイ自体にも `overflow-y: auto` を付与し、万一モーダルが可視範囲より高くなってもスクロールで必ず到達できるようにする（保険）、③ モバイル時のオーバーレイ上端に `env(safe-area-inset-top)` 分の余白を追加し、ノッチ/ステータスバーとの重なりを避ける
- **ツールバー**（担当者フィルターの行）: 左に担当者フィルター（チップ）、右に最終取得時刻・**「アーカイブ」ボタン（グレー背景）**（アーカイブ画面へ遷移）。**「今すぐ取得」ボタンは2026-07-21にハンバーガーメニューへ移動済み**（上記共通ヘッダー参照）
- 4列カンバン（列背景はステータス色を薄く混ぜた濃いめの色）。ステータス名 16px
- タスクカード: **タイトル先頭に情報源アイコン**（上記）/ 送信元（会社・氏名。旧データは From 表示名で代替）/ 担当者アバター / 期限（超過・間近バッジ）/ 受信日時 / **留意事項（remarks、あれば青字で常時表示。2026-07-21に「件名を表示」の開閉トグルから変更）** / **「新着」バッジ（2026-07-22。カード右上。`tasks.updated_at`が24時間以内なら表示。登録時・自動更新・手動編集のいずれでも`updated_at`が更新されるため「取得または更新から24時間以内」の判定にそのまま使える）**
- 未処理列のヘッダーに新規タスク手動登録の「＋」ボタン（**青地＋白文字**で強調）
- 担当者フィルター（チップ、15px）。ドラッグ＆ドロップでステータス変更（`PATCH /api/tasks` 経由。service role・JWT必須）
- タスク詳細モーダル（幅820px・視認性重視で文字は大きめ・モバイルは1カラム）: タイトル+×は固定ヘッダー、最下部は固定フッタ。フッタ左に「ステータス」見出し＋変更ボタン、右に「メール参照」「返信」ボタン
  - **1行目に担当者・受信日時・期限を横並び**表示（`task-detail-toprow`）。ステータスはフッタの変更ボタンと重複するため本文側では省略
  - **送信者の右隣に発信元の宛名**（`contact`）を表示。`contact` が無ければ `sender_display`＋「様」で補う（生成前の既存タスク向けフォールバック）
  - **タイトル先頭に情報源アイコン**（上記）を表示
  - 担当者・期限・留意事項（remarks）は詳細画面で編集。**「保存」ボタンは1行目（期限の行）の右端**に青色で配置（`PATCH /api/tasks`）。担当者が「（担当未設定）」のときはオレンジで警告
  - フッタの「ダウンロード」「返信」は黒背景ボタン
  - **添付ファイル**（メール由来タスクのみ）: 開いた時に**スレッド全体**の添付一覧を Gmail から取得（対象顧客宛メッセージのみ・別顧客分は除外）。ありなら「📎 添付あり」バッジ＋ファイル名・サイズ・[ダウンロード]ボタンを表示。返信で本文が上書きされても最初・途中の添付は残る。ダウンロードは Worker 経由で取得（後述 4-5）
  - **メール参照**: Gmail のウェブ画面で該当メールを開く（`https://mail.google.com/mail/?authuser=<共有アドレス>#all/<gmail_message_id>`。パスに `/u/<アドレス>` を埋め込む形式は 404 になることがあるため authuser クエリを使う。共有アカウントへのログインが必要）
  - **返信**: `mailto:` でメーラーの返信画面を開く。TO=タスクの返信先アドレス（フォーム経由は本文記載のアドレス）、CC=`if@eiwa-up.jp`（固定。同アドレス宛は共有 Gmail にも配信されるため返信検知の対象になる）。**本文の先頭に先方の宛名（`contact`。無ければ `sender_display`＋様）を入れ、そのあと2行の空行**を空け、続けて元メールを引用
- クレジット不足時は警告バナー＋「APIクレジットをチャージ」ボタン
- **アプリ更新バナー**（PWA）: 新バージョン検知時に画面上部へ「新しいバージョンがあります → 更新」を表示（後述 4-6）
- ヘッダー左のロゴはタップで最新化ボタンを兼ねる。ロゴ横に `ver.YYYY-MM-DD HH:MM`（ビルド時刻・JST）を表示

**処理ログ画面（/logs）**（共通ヘッダー＋`<h2 className="page-title">処理ログ</h2>`。「×」で閉じるボタンは無く、ハンバーガーメニューから他画面へ遷移）:
- 直近200件を表形式で表示: 日時 / 種別（メール取得・ステータス変更）/ 実行者 / 内容
- 実行者は担当者の表示名（手動操作）または「システム（自動）」（Cron 実行・返信自動検知）
- **表示幅は画面いっぱい**（2026-07-18: `.logs-container` の `max-width: 1100px` を撤廃。広い画面で余白を残したまま列が折り返される問題を解消）

**アーカイブ画面（/archive）**（4-8 参照。共通ヘッダー＋ページタイトル）:
- 処理ログと同じ一覧表形式（情報源アイコン / タイトル / 担当者 / 期限 / 受信日時 / アーカイブ日）。行タップでタスク詳細モーダルを開く
- 絞り込み: 担当者・情報源のプルダウン ＋ フリーワード全文検索

**設定画面**（共通ヘッダー＋ページタイトル）:
- ページタイトル行に保存メッセージ /「保存」（青）ボタン。※支払設定・利用状況は「従量課金事項」画面へ移動
- 2カラム。左: 「更新頻度と時間帯」（開始時・終了時・頻度分を1行）/ **「完了タスクのアーカイブ」（アーカイブまでの日数。0で無効）** / 担当者名（改行区切りの1つのテキストエリア。1行に1名。DBはJSON配列のまま）/ **「業務関連であると判定するワード」**（旧称「業務判定のキーワードヒント」）。右: 業務背景・振り分けルール（org_context、大きな入力欄）
- フォントは視認性のため少し大きめ（label 15px / h2 16px 等）
- **ウインドウ高さへの追従（2026-07-18）**: 幅900px超では画面全体をウインドウの高さに収め、ページ全体の縦スクロールバーを出さない（`.settings-page { height: 100vh; overflow: hidden }`）。左カラムは縦積みflexで項目間隔を詰め、収まらない場合は**左カラムのみ内部スクロール**する。右の「業務背景・振り分けルール」欄は幅・高さともに残りいっぱいまで伸縮する。左カラムの各入力欄は担当者名欄と同じ横幅に統一（`width: 100%`）。900px以下では従来どおり1カラム・ページ全体スクロールに戻る

**従量課金事項画面（/usage）**:
- 共通ヘッダー＋ページタイトル。ハンバーガーメニューの「従量課金事項」（設定の下）から遷移
- 「今月の Anthropic API 利用状況」（対象月・**分類したメール件数・分類したFAX件数**・入出力トークン・推定コストを縦並び・値のタブ位置を揃えて表示）＋試算の注釈
  - **FAXの内訳を分離表示（2026-07-18）**: FAX（添付PDF/画像の読取を伴う分類）は通常メールより入出力トークンが多く、将来的にFAXのみ上位モデル（Sonnet等）へ切り替える可能性があるため、「分類したメール」件数はFAXを除いた件数、別行で「分類したFAX」件数を表示する。トークン数・推定コストは現状メール/FAX合算のまま（内訳データは `api_usage` に保持済み。単価別コスト試算はまだ未実装。5章参照）
- 最下部に「Anthropic API 支払設定」ボタン（赤。以前は設定画面ヘッダーにあったものを移設）

### 4-4. API エンドポイント（Worker）

**2026-07-16 の変更**: 従来はフロントエンドが anon(publishable) キーで Supabase を直接読み書きしていたが、この鍵は公開値であり匿名の第三者が全顧客データを読み取れる致命的な脆弱性だったため全廃した。**データ面（tasks/settings/logs/usage）へのアクセスはすべて Worker の `/api/*` を JWT 認証つきで経由する**方式に統一している（詳細は 8 章）。

| メソッド/パス | 認証 | 内容 |
|---|---|---|
| POST `/api/login` | 不要 | bcrypt 照合 → HS256 JWT（**30日**有効、`tv`=token_version を埋め込み）を発行。IP+ユーザー名ごとの失敗回数を記録し、8回失敗で15分ロックアウト |
| GET `/api/tasks` | JWT | カンバン用タスク一覧（受信日時の新しい順）。**アーカイブ済み（`archived_at` 非NULL）は除外** |
| POST `/api/tasks` | JWT | タスクの手動登録（`source='manual'`、id は `manual:<uuid>`） |
| PATCH `/api/tasks` | JWT | `assignee` / `due_date` / `remarks` / `title` / `status` を更新。`status` 変更時はサーバー側で操作ログ（`activity_logs`）を記録し、完了への遷移で `completed_at` を記録／完了以外で `completed_at`・`archived_at` をクリア |
| GET `/api/archive` | JWT | アーカイブ済みタスク一覧（アーカイブ日の新しい順・上限500）。`assignee`（担当者）・`channel`（情報源）で絞り込み、`q` でフリーワード全文検索（PostgRESTフィルタ注入対策としてサニタイズ） |
| GET `/api/settings` | JWT | 設定一覧（`{key: value}`） |
| PUT `/api/settings` | JWT | 許可キーのみ settings に upsert |
| GET `/api/logs` | JWT | 操作ログ（新しい順・上限200） |
| GET `/api/usage` | JWT | `month=YYYY-MM` の月次API利用量（入出力トークン・件数、および2026-07-18よりFAX分の内訳 `fax_calls`/`fax_input_tokens`/`fax_output_tokens` を含む） |
| POST `/api/run-fetch` | JWT | パイプラインを force=true で即時実行 |
| GET `/api/attachments` | JWT | `thread_id=…`（必須）でスレッド全体の添付一覧（ファイル名/MIME/サイズ/attachmentId/所属 message_id）を集約して返す。`thread_id` が `tasks.gmail_thread_id` に存在しないと404。対象タスクの顧客宛メッセージのみに絞り込み |
| GET `/api/attachment` | JWT（または`preview_token`） | `thread_id`・`message_id`・`attachment_id` が必須。`thread_id` に対応するタスクが存在し、`message_id` がそのスレッドに実在することを検証してから本体を返す（`Content-Disposition: attachment`、日本語名は RFC5987 併記）。クエリに対象と一致する有効な`preview_token`（下記発行）があれば、通常のBearer認証の代わりとして受け付け、`Content-Disposition: inline`で返す（PDFプレビュー用） |
| POST `/api/attachment/preview-token` | JWT | PDFのアプリ内プレビュー用に、対象の`thread_id`/`message_id`/`attachment_id`に紐付けた120秒だけ有効なトークンを発行する（4-5参照） |
| GET `/api/push/public-key` | JWT | Web Push購読作成用のVAPID公開鍵を返す（4-9参照）。未設定時は404 |
| POST `/api/push/subscribe` | JWT | ブラウザの`PushSubscription`（`endpoint`/`keys.p256dh`/`keys.auth`）を`push_subscriptions`に保存（`endpoint`で upsert） |
| POST `/api/push/unsubscribe` | JWT | 指定`endpoint`の購読を削除（自分（トークンのuser_id）に紐づくもののみ） |
| その他 | — | dist/ の静的アセット（SPA フォールバック） |

- 認証必須 API は `Authorization: Bearer <JWT>` を要求。署名・有効期限に加え、`users.token_version` との突合による失効チェックも行う（不一致・DB参照失敗はフェイルクローズで無効）。**トークン期限切れ（401）時はフロントが自動ログアウトして `/login?expired=1` へ誘導**（`authFetch`）
- settings の許可キー: `fetch_interval_minutes`, `active_hours_start`, `active_hours_end`, `assignees`, `business_keywords`, `org_context`, `shared_gmail`, `company_domains`, `calendar_name`, `archive_after_days`
- 添付系APIは `thread_id` 必須（`message_id` 単体でタスクに紐づかない共有メールボックスの任意メッセージを引ける経路は廃止済み）
- 全レスポンス（API・静的アセット共通）に `X-Frame-Options: DENY` / `X-Content-Type-Options: nosniff` / `Referrer-Policy: strict-origin-when-cross-origin` / `Content-Security-Policy`（ほぼ全ディレクティブ `'self'`）を付与（`worker/lib/http.js` の `withSecurityHeaders`）

> **実装ノート（カレンダーIDの扱い）**: 「栄和共通」は独立した副カレンダーではなく、共有アカウント `eiwa.public@gmail.com` の**メイン（デフォルト）カレンダーに付けた表示名**だった。メインカレンダーの ID はアカウントのメールアドレスそのもの（`eiwa.public@gmail.com`）であり、`calendarList.list` では表示名ではなくメールアドレス名で返るため「栄和共通」という名前では解決できなかった。このため `calendar_name` にカレンダーID（`eiwa.public@gmail.com`）を直接指定する運用にしている。

### 4-5. 添付ファイル表示・ダウンロード

- メール由来タスクの詳細画面を開くと、`GET /api/attachments?thread_id=…` で**スレッド全体の添付一覧をその場で Gmail から取得**して表示する（`gmail.js` が各メッセージの payload を再帰的に辿り、`filename` と `body.attachmentId` を持つパートを抽出。署名等に埋め込まれたインライン画像 = `Content-Disposition: inline` の image/* は除外）。**ただしサイズが `INLINE_LOGO_MAX_BYTES`（20KB）を超えるインライン画像は除外しない**（2026-07-22。iPhone等のメールアプリで本文に直接貼り付けられた写真は`cid:`参照のインライン画像として送られるが、数百KB〜数MBあるため、数KB程度の署名ロゴ画像とサイズで区別する。「旧本社通用扉のノブに付けられた器具の報告」タスクの写真がこの除外条件に該当しダウンロードできなかった事象を受けて調整）。ダウンロード対応はPDFに限定されておらず、Gmailの実ファイル添付であれば画像を含め元々どの形式でも対象。
- **スレッド集約**: 返信で本文が上書きされても最初・途中の返信の添付が失われないよう、スレッド内の全メッセージの添付を集約する（同一ファイル=名前+サイズ+MIME は1件に集約）。ただし同一件名で複数顧客が1スレッドにまとまる場合に別顧客宛の添付が混ざるのを防ぐため、**対象タスクの顧客(counterpart)が参加している（From/To/Cc に含む）メッセージの添付だけ**に絞り込む（counterpart は `mail-utils.js` で特定）。各添付は所属 `messageId` を持ち、ダウンロード時に使う。
- **FAX の例外（2026-07-17）**: `channel='fax'` のタスクはスレッド集約を行わず、タスクの元メッセージ（`gmail_message_id`）単体の添付だけを返す。FAXは件名共通で複数が1スレッドに混在し、送信元も共通で counterpart 絞り込みが効かないため。
- 各ファイルの [ダウンロード] は `GET /api/attachment` を叩き、Worker が Gmail の `messages/{id}/attachments/{attachmentId}` から本体（base64url）を取得してバイト列で返す。フロントは Bearer 付き fetch → Blob 化してダウンロードを起動する（`src/lib/api.js` の `fetchAttachmentBlob` が共通の取得処理、`downloadAttachment` がそれを使ってダウンロードを起動する）。
- **アプリ内プレビュー（2026-07-22）**: 画像・PDFの添付には [ダウンロード] と並べて [プレビュー] ボタンを表示（他形式はダウンロードのみ）。モーダル（`src/components/AttachmentPreview.jsx`）内で画像は`<img>`、PDFはブラウザ内蔵のPDFビューアを使う`<iframe>`で表示する（追加ライブラリなし）。タスク詳細モーダル（z-index:50）の上に重ねて表示する（z-index:60）ため、背景クリック・Escapeキーで閉じる際にタスク詳細モーダルまで一緒に閉じないよう、クリックイベントの伝播を止め、プレビュー表示中はタスク詳細側のEscape/Tab処理を無効化している（`previewOpenRef`）。
  - **画像**: `fetchAttachmentBlob` で取得したBlobを`URL.createObjectURL()`で表示する。閉じる時・タスク切り替え時に`URL.revokeObjectURL`で解放する。
  - **PDF**: Blob URLではなく、`POST /api/attachment/preview-token` で発行する**短時間（120秒）だけ有効な直接アクセスURL**（`getAttachmentPreviewUrl`）へ`<iframe>`をナビゲーションさせる（下記「PDFプレビューのSafari対応」参照）。
  - **CSPによる表示不具合の修正（2026-07-22）**: リリース直後、画像・PDFのプレビューが表示されない（画像は壊れて見え、PDFは真っ白）事象が発生。原因は `worker/lib/http.js` のContent-Security-Policyで、プレビューが使う`blob:`スキームのURLが`img-src`（`'self' data:`のみ）にも`frame-src`（未指定のため`default-src 'self'`にフォールバック）にも含まれておらずブロックされていたため。`img-src`に`blob:`を追加し、`frame-src 'self' blob:`を新設して解消した。
  - **PDFプレビューのSafari対応（2026-07-22）**: 上記CSP修正後も、**PDFはSafari（Mac・iPhoneとも）でのみ真っ白のまま**（Chromeでは正常表示）という事象が発生。原因は、SafariがBlob URLのPDFを`<iframe>`内に正しく描画できないという、WebKitの長年の既知の問題（iOS8以降で報告され現在も未解消。画像のBlob URLはSafariでも問題なく表示できるためPDF固有の問題）。対策として、PDFのプレビューだけBlob URLをやめ、`POST /api/attachment/preview-token`（ログイン必須）が発行する短時間（120秒）有効なJWT（`worker/lib/jwt.js`の既存のHS256署名を流用。対象のthread_id/message_id/attachment_idに紐付けて署名するため他の添付には転用できない）を`preview_token`としてクエリ文字列に含めた直接URLへ`<iframe>`をナビゲーションさせる方式に変更。`GET /api/attachment`はこのトークンが対象と一致する場合に限り、通常のBearer認証（Authorizationヘッダ。iframeのsrc属性からは送れない）の代わりとして受け付け、`Content-Disposition: inline`で返す（通常のダウンロード時は`attachment`のまま）。画像は従来通りBlob URLのまま（Safariでも問題ないため変更不要）。
  - **PDF直接URL方式のフレーム埋め込み許可（2026-07-23）**: 上記のSafari対応でPDFのiframeをBlob URLから実URL（`/api/attachment`）へ切り替えた結果、今度は**Chromeで「接続が拒否されました」**になる事象が発生。原因は、全レスポンス共通の`withSecurityHeaders`が付与する`X-Frame-Options: DENY`とCSP`frame-ancestors 'none'`により、同一オリジンのプレビューiframeでもフレーム埋め込みが拒否されていたため（Blob URLはクライアント生成でこれらのヘッダを持たないため従来は表示できていた）。対策として、`handleDownloadAttachment`が**preview_token経由のレスポンスのときだけ**`X-Frame-Options: SAMEORIGIN`とCSP`frame-ancestors 'self'`を先に設定し、`withSecurityHeaders`は既存の`X-Frame-Options`を上書きしないよう変更（自オリジン限定に緩めるのみで、他サイトからのクリックジャッキングは引き続き防止）。通常のダウンロード（`attachment`）は従来通り`DENY`のまま。
  - **画像のズーム機能（2026-07-22）**: 画像プレビューはホイール/ピンチでの拡大縮小、ドラッグでの移動、ダブルクリックでの拡大/リセット、±ボタン・リセットボタンに対応（`AttachmentPreview.jsx`。1〜5倍の範囲。外部ライブラリ不要。`touch-action: none`でブラウザ標準のタッチ操作を無効化し、自前のPointer Events/Touch Eventsで制御）。PDFはブラウザ内蔵のPDFビューア自体がズーム機能を持つため対象外。
- **設計判断**: 添付メタ情報を DB に持たせず取得のたびに Gmail へ問い合わせる方式にした。理由は (1) 既存タスクにも追加改修なしで対応できる、(2) メール取得パイプライン・スキーマに手を入れずリスクを抑えられる、(3) 共有アカウントの認証情報で取得するので担当者個人の Gmail ログインが不要。既存の `gmail.readonly` スコープで動作する。

### 4-6. PWA（アプリ更新の通知・明示的な最新化）

別プロジェクトのスキル `pwa-auto-update` を Vite + React 向けに移植して適用。**キャッシュを一切行わない最小 Service Worker**を採用しているのが要点。

- **Service Worker（`public/sw.js`。`scripts/generate-sw.mjs` がビルド時に生成）**: `fetch` ハンドラを持たず、リクエストを横取りしない。役割は「更新の検知」と「`SKIP_WAITING` による有効化」のみ。`SW_VERSION`（git SHA）を刻印し、デプロイごとに内容が変わることでブラウザが新版を検知する。`activate` 時に旧キャッシュを掃除し `clients.claim()`。
  - ※ キャッシュ型 SW（`vite-plugin-pwa`/Workbox 等）は Cloudflare 環境でナビゲーション/RSC を横取りして遷移を壊す事例があるため**採用しない**。この SW に fetch/キャッシュ処理を足さないこと。
  - **既知の不具合と対策（2026-07-18）: 更新チェックがブラウザ/中間キャッシュの影響を受けうる**。`register()` に `updateViaCache` を指定しないと、ブラウザや経路上の中間キャッシュ（CDN・プロキシ等）の挙動次第で `/sw.js` の新版が取得できず、何度デプロイしても更新バナーが出ない・ロゴタップでも最新化されないことがある（実際に発生・修正済み）。対策は二重で行う: ① クライアント側で `register("/sw.js", { updateViaCache: "none" })` を指定（`src/pwa/ReloadPrompt.jsx`）、② サーバー側で `/sw.js` のレスポンスにだけ明示的に `Cache-Control: no-store, no-cache, must-revalidate` を付与（`worker/index.js`。Cloudflare Workers の静的アセット配信は既定でキャッシュ可能なヘッダーを返しうるため）。
  - **上記②が実際には無効だった不具合と是正（2026-07-21）**: `wrangler.jsonc` の `assets.run_worker_first` が `["/api/*"]` のみだったため、`/sw.js` や `/settings` 等それ以外のパスは **Cloudflareの静的アセット配信層がWorkerを一切経由せず直接応答**しており、②の `worker/index.js` 側のCache-Control上書きコードが（`node --check`やビルドは通っていても）実際には一度も実行されていなかった（デバッグヘッダーを仕込んで確認し発覚）。この場合、①のクライアント側対策のみで更新バナーの表示自体はある程度機能していたが、**index.html（SPAシェル）も同様にキャッシュされうる**ため、更新ボタン/ロゴタップでリロードしても参照するJS/CSSバンドルが古いままで見た目が変わらない不具合が別途起きていた。`run_worker_first` を `true`（全パスをWorker経由）に変更して是正。ハッシュ付きファイル名のJS/CSS/画像等は `route()` 内で素通しするため、通常のアセットキャッシュの挙動・性能は変えていない。**教訓**: `assets.run_worker_first` で対象パスを絞っている場合、対象外パスの応答は静的アセット配信層が直接返す＝Worker内の該当コードが実行されない。ヘッダー付与等をWorker側で行うコードを書いたら、`wrangler dev` で実際に対象パスのレスポンスヘッダーを確認すること（ローカルビルド・lintが通ることは実行されている保証にならない）。
- **更新バナー（`src/pwa/ReloadPrompt.jsx`）**: 新版検知時に画面上部へ「新しいバージョンがあります → 更新」を表示。約1分間隔で `registration.update()` をポーリング。更新ボタン押下で `SKIP_WAITING` を送り、「更新中…」表示を約0.8秒見せてからリロード（クリックを明確に認知させるため）。本番ビルドのみ描画（`import.meta.env.PROD`）。初回インストール時は自動リロードしないガードあり。
- **ロゴタップ最新化（`src/pwa/reloadApp.js`）**: ダッシュボード左上のロゴがボタンを兼ね、待機中の新 SW があれば有効化してリロード（iOS 向けの保険タイマー付き）。**遷移先はトップページ（`/`）固定**（2026-07-22。`window.location.assign('/')`。設定画面・処理ログ等どのページからタップしても、最新化後は必ずメイン画面に戻る）。
- **表示用バージョン（`src/lib/version.js`）**: `vite.config.js` の `define` でビルド時刻を `__BUILD_TIME__` に埋め込み、ヘッダーに `ver.YYYY-MM-DD HH:MM`（JST）を表示。端末が最新デプロイを取得できているかの確認用（更新“検知”は SW_VERSION が担い、この表示値とは独立）。
- **マニフェスト（`public/manifest.webmanifest`）**: ホーム画面追加用。theme_color=#33604d。`index.html` に manifest link・apple-touch-icon・`viewport-fit=cover` を追加。
- `npm run build` は `node scripts/generate-sw.mjs && vite build`。`public/sw.js` は生成物のため gitignore。

### 4-7. FAX・PDF添付の読み取り分類（2026-07-16）

複合機からのFAX転送メール（本文がほぼ無く、内容がPDF/画像）や、注文書・見積書・請求書などのPDF添付を、通常メールと同等に処理対象にする機能。

- **`worker/lib/gmail.js`**: `getMessage` の戻り値に `attachments`（filename / mimeType / size / attachmentId）を追加。`format=full` で取得済みの payload から抽出するため追加のAPI呼び出しは無い。
- **`worker/lib/anthropic.js`**: `classifyEmail(email, context, documents)` の第3引数 `documents` に、対応形式の添付をPDFは `document` ブロック（`{type:'document', source:{type:'base64', media_type:'application/pdf', data}}`）、画像は `image` ブロックとして渡す。システムプロンプトに添付読取の指示と出力項目 `document_summary` を追加。添付ありのときは `max_tokens` を引き上げる（400→1500）。
- **`worker/lib/pipeline.js`**: `collectClassifierDocuments()` が対応形式（PDF・PNG・JPEG・GIF・WebP。TIFFは非対応）の添付を、サイズ上限（1ファイル10MB・合計12MB）・件数上限（5件）でフィルタしつつ `getAttachmentData` で取得し、base64url→標準base64に変換して分類器へ渡す。
- **非対応形式**: TIFF（Claude非対応）。複合機のFAXが `mimi@eiwa-up.com` 宛にTIFF形式で転送される運用が残っている場合、その添付は読み取れない（PDF転送であれば読み取れる）。
- **取り込みの前提条件（重要）**: システムはGmail APIで共有アカウント（`eiwa.public@gmail.com`）のメールを取得する。**メーリングリスト/Googleグループ宛に届いたメールはGmail APIの検索・取得対象に入らない**（Web画面には見えるがAPI経由では取得できない）。従来、複合機からのFAX転送はメーリングリスト形式のエイリアス `if@eiwa-up.jp` 経由で届いており、この制限に該当してタスク化されない／複数FAXが混線する原因になっていた（4-5・下記参照）。
  - **解消済み（2026-07-18）**: FAXの転送先を共有アカウント `eiwa.public@gmail.com` 宛の**直接転送**に変更し、この制限を回避した。以降に着信するFAXから本来の取り込み精度で処理される見込み（実運用での確認は今後の着信を待って行う）。
- **FAXの添付表示（2026-07-17修正）**: FAX転送メールは件名が「Attached Image」等で共通するため、Gmail側で複数の別々のFAXが同一スレッドにまとまることがある。送信元も全FAX共通のため counterpart 絞り込みが効かない。そこで **`channel='fax'` のタスクはスレッド集約を行わず、タスクの元になった単一メッセージの添付だけ**を表示する（4-5参照）。
- **読み取り失敗時のハルシネーション対策（2026-07-21）**: FAXはスキャン品質により文字がかすれる・低解像度・手書きなどで判読困難なことがあり、Claudeが読み取れないにもかかわらず会社名・金額・内容などを推測で創作してしまう事例が実際に発生した（実在しない顧客名でタスクが登録される等）。対策として、分類プロンプトに新しい出力項目を追加した。
  - `document_readable`（true/false）: 添付の内容を**自信を持って明確に判読できたときのみ true**。少しでも不鮮明・推測が混じる場合は false にするようプロンプトで明示的に指示。
  - `document_read_issue`: `document_readable` が false のときの理由（画質不良・低解像度・手書きで判読困難 等）。
  - `channel='fax'` かつ `document_readable=false` のとき（`worker/lib/pipeline.js` の `isFaxReadFailure`）:
    - タイトルを固定文言「**（FAX内容の読み取り失敗）**」にする（`title`/`sender_display`/`contact`/`due_date`/`document_summary` など添付由来の情報は一切使わず、内容の創作を防ぐ）
    - 本文プレビューに読み取り失敗の理由（`document_read_issue`）を記載し、「添付のFAX画像/PDFを直接ご確認ください」と案内する
    - 担当者は「（担当未設定）」にして画面でオレンジ警告表示し、人が気づいて添付を直接確認できるようにする
    - `is_business_task` の判定自体も読み取り失敗時は信頼できないため、判定結果によらず**必ずタスク化**する（添付ファイルは通常どおりタスク詳細から参照・ダウンロード可能。4-5参照。新規の添付保存機構は不要）
  - この対策はハルシネーションの完全な防止ではなく、AIの自己申告（読み取れたかどうかの明示的な自己評価）に基づく緩和策である点に留意。実運用で効果を検証しつつ、FAX読み取りのみ上位モデル（Sonnet等）へ切り替えるかどうかは別途検討中（トークン単価が上がるため保留。従量課金事項画面のFAX内訳4-3・9章参照）
- **`is_business_task=false`誤判定によるFAXの見落とし対策（2026-07-22）**: 読み取り自体（`document_readable`）は成功しているのに、`is_business_task`（業務判定）がfalseと誤判定され、タスクにも操作ログにも一切痕跡を残さず静かに破棄されるFAXが実際に発生した（通常メールの業務外判定と異なり、FAXは件数が少なく誤検知の実害＝無関係なタスクが1件増える程度が小さい一方、見落としの実害＝顧客対応漏れが大きい）。このため`channel='fax'`のタスクは`is_business_task`の判定によらず**必ずタスク化**するよう変更（`worker/lib/pipeline.js`の`isFaxNonBusinessOverride`）。業務外と判定された場合はその旨を留意事項（`classification_note`）に記載し、担当者が内容を確認して不要なら完了にできるようにする。**現状の運用方針（2026-07-22時点）**: 業務判定の精度検証と読み取り内容の観察を優先するため、当面はFAX全件をタスク化する。明らかにプロモーション/広告と分かるものはユーザー側が実例を確認しながら判定基準（キーワード等）を今後提示する予定で、それを踏まえて自動除外や表示上の区別（色分け等）を検討する（現時点は未実装）。
- **FAX等でtitleが元の件名のままになる問題の修正（2026-07-22）**: 上記の動作確認中、`is_business_task=false`と判定されたFAX（実例: 仕入れ先モノタロウからの15%OFFキャンペーン案内）で、`document_summary`は正しく内容を読み取れているのに`title`が空のままとなり、結果としてタイトルが元のメール件名（FAX共通の定型件名「Attached Image」）にフォールバックしてしまう問題が判明。①分類プロンプト（`worker/lib/anthropic.js`）に「`is_business_task`がfalseでも、内容が読み取れているならtitleは必ず具体的に埋める（元の件名をそのまま使い回さない）」旨を明記、②保険として`worker/lib/pipeline.js`にコード側フォールバックを追加（Claudeのtitleが空なら`document_summary`の最初の文（句点/改行区切り、30字超は省略）から代替タイトルを自動生成。それも無ければ従来どおり`email.subject`にフォールバック）。
- **FAX本文のノイズ除去（2026-07-22）**: FAXゲートウェイの本文は`FROM=/TO=/DATE=/TIME=/TIMEZONE=/FCODE=/RJOBNUM=`という受信情報のみで業務内容を含まない。このうち**RJOBNUM（受信ジョブ番号。複合機側で受信書類の特定に使う）だけは残す価値がある**ため、FAXタスクの`body_preview`はFROM/TO/DATE/TIME/TIMEZONE/FCODEの行を表示せず、RJOBNUMの行＋添付の自動読取要約（`document_summary`）だけを表示する（`worker/lib/pipeline.js`の`faxJobNumberLine`）。
- **既知の定期取引先メールの業務判定を確実にする（2026-07-22）**: `org_context`に「實守紙業の数量報告は西川が担当」という明示ルールがある定期報告メールが、`is_business_task=false`と誤判定されてタスク化されず見落とされる事象が発生（本文がほぼ定型文のみのメールで、この明示ルールがあってもClaudeの業務判定が安定しないケースがあると判明）。問い合わせフォーム判定（`isFormSubmission`）と同じ考え方で、送信元に`jitsumori.co.jp`を含み件名に「数量報告」を含むメールは`is_business_task`の判定によらず確実にタスク化するようにした（`isJitsumoriQuantityReport`）。担当者もClaudeが正しく割り当てられなかった場合は西川にフォールバックする。同様の「org_contextに明記された既知の定期取引先パターンなのに業務判定が不安定」な事例が他に見つかれば、同じ方式（送信元・件名パターンでの決定的な判定）で個別対応する想定。

### 4-8. 完了タスクのアーカイブ（2026-07-17）

「完了」列にタスクが溜まり続けるのを防ぐため、一定日数を超えた完了タスクをアーカイブへ移し、専用画面で参照する。

- **移行**: パイプライン（メール取得時）で、`status='完了'` かつ `completed_at` が `archive_after_days`（設定・既定30。0で無効）日より前のタスクに `archived_at` をセットする。`completed_at` を持たない旧データは対象外。
- **`completed_at` の記録**: `PATCH /api/tasks` でステータスが「完了」になった時に記録。完了以外へ戻すと `completed_at`・`archived_at` をクリアしてカンバンへ復帰させる。
- **カンバンからの除外**: `GET /api/tasks` は `archived_at` 非NULLを除外する。
- **アーカイブ画面（`/archive`）**: `GET /api/archive` で取得。担当者・情報源での絞り込みと、フリーワード全文検索（タイトル・件名・本文・送信者・宛名・留意事項をサーバー側 ilike で横断）。行タップで既存のタスク詳細モーダルを開く（編集・ステータス変更も可能）。
- **既存の完了タスクの扱い**: 導入時のマイグレーションで、既存の完了タスクは `updated_at` を `completed_at` の代替として補完済み。デプロイ後、次回のパイプライン実行時にまとめてアーカイブへ移る。

### 4-9. 新規タスク登録時のWeb Push通知（2026-07-21）

メール/フォーム/FAX/Googleカレンダーから**自動登録**されたタスクについて、購読中のブラウザ/端末へWeb Push通知を送る。手動登録（画面の「＋」からの登録）は対象外（登録した本人が既に画面上にいるため）。

- **暗号化方式**: RFC 8291（`aes128gcm`）準拠。npmパッケージ `web-push-browser`（ゼロ依存・WebCrypto APIのみで実装、Cloudflare Workers対応）を使用。古い草案の `aesgcm` 方式は現在のSafari等では復号できないため使わない。
- **VAPID鍵**: `web-push-browser` の `generateVapidKeys`/`serializeVapidKeys` で1回だけ生成し、`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` としてSecretsに保存（6章）。未設定の間は `worker/lib/push.js` が何もせず処理をスキップする（通知機能オフ。パイプライン自体は正常に動く）。
- **購読の保存**: `push_subscriptions` テーブル（5章）。`endpoint` は端末（ブラウザインストール）ごとに一意なため、同じ端末からの再購読は upsert で1行に保つ。
- **購読UI**: ハンバーガーメニュー内「通知をオンにする/オフにする」（`AppHeader.jsx` / `src/lib/push.js`）。`Notification.requestPermission()` → `PushManager.subscribe()` → `POST /api/push/subscribe`。ブラウザが対応していない場合はメニュー項目自体を表示しない。ブラウザ側で通知がブロックされている場合はグレー表示で理由をtitle属性に表示。**🔔絵文字は通知が有効（オフにする表示）のときだけ**付ける（2026-07-22。文言だけではオン/オフの変化に気付きにくいとの指摘のため）。
- **通知の送信**: `worker/lib/push.js` の `notifyNewTask()` を、`pipeline.js` の通常タスク登録・カレンダータスク登録の直後に呼ぶ。全購読者へ一律送信（担当者に限定しない）。送信失敗時にステータス404/410（購読失効）が返った購読はDBから削除する。パイプライン全体を止めないよう、通知処理の例外は握りつぶしてログにのみ残す。
- **通知タップ時の遷移**: メイン画面（`/`）を開く。タスクの個別URLは無い（SPAのモーダル表示のため）ので、開いたあと該当タスクをカンバンから探す形になる。
- **iOS/Safariの制約**: iPhoneは**ホーム画面に追加したPWA（スタンドアロン表示）からのみ**通知を受け取れる。Safariのタブで開いているだけでは通知が届かない。
- **未検証事項**: 実際のプッシュ配信（ブラウザの購読作成〜Push送信〜端末での表示）はこのサンドボックス環境では検証できていない（実機・実ブラウザでの確認が必要）。エンドポイントの疎通・エラーハンドリング・UIの状態遷移は確認済み。

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
| contact | text | 先方担当者の宛名（会社・氏名＋様）。返信メール冒頭・詳細画面の送信者右隣に使う。AI 抽出、無ければ `sender_display`＋様。本番に既存の列 |
| sender_email | text | 返信先アドレス（フォーム経由は本文記載を優先） |
| source | text | 取得元。`email`（Gmail）/ `calendar`（Google カレンダー）/ `manual`（手動登録）。既定 email。返信検知等のロジックで使用 |
| channel | text | 情報源アイコン表示用の経路種別 `email`/`form`/`fax`/`calendar`/`manual`。source='email' の内訳（通常/フォーム/FAX）を区別。source とは独立（マイグレーション `add_tasks_channel`。旧データは source から補完済み） |
| subject / body_preview | text | body_preview は先頭 20000字（`MAX_BODY_PREVIEW`。引用履歴を含む全文を保持。改行も保持） |
| remarks | text | 留意事項。詳細画面で手動入力（マイグレーション `add_remarks_to_tasks`） |
| last_reply_message_id | text | 最後に取り込んだ返信の Gmail message id。返信検知の冪等化用（マイグレーション `add_last_reply_message_id_to_tasks`。NULL 可） |
| classification_note | text | AI の判定理由 |
| completed_at | timestamptz | ステータスが「完了」になった日時。アーカイブ移行の起点（マイグレーション `add_tasks_archive`。旧完了タスクは updated_at で補完） |
| archived_at | timestamptz | アーカイブ移行日時。非NULL＝アーカイブ済み（カンバンから除外・アーカイブ画面で参照） |
| received_at / created_at / updated_at | timestamptz | updated_at はトリガーで自動更新 |

> 添付ファイルは DB に保持しない（詳細画面を開くたびに Gmail から取得。4-5 参照）。手動登録タスクは `source='manual'`、`gmail_thread_id`/`gmail_message_id` が `manual:<uuid>`。

### settings（key/value）
`fetch_interval_minutes`(30), `active_hours_start`(8), `active_hours_end`(18), `assignees`(["橋口","西川","岡田"]), `business_keywords`, `org_context`, `shared_gmail`(eiwa.public@gmail.com), `company_domains`(eiwa-up.jp。自社ドメイン、カンマ区切り), `calendar_name`, `archive_after_days`(30。完了からアーカイブまでの日数。0で無効), `api_credit_alert`, `last_fetch_at`

### users
id / username(unique) / password_hash(bcrypt) / display_name / **token_version**(既定0) / created_at。**anon からは一切アクセス不可（service role のみ）**

`token_version` はJWT失効用（2026-07-16追加）。ログイン時に発行するJWTへ発行時点の値を `tv` として埋め込み、以後のリクエストで現在値と突合する。パスワード変更・退職・トークン漏洩時にこの値をインクリメントするだけで、有効期限（30日）を待たずに当該ユーザーの全トークンを即時失効できる。

### api_usage
month(PK, 'YYYY-MM') / input_tokens / output_tokens / calls / **fax_calls / fax_input_tokens / fax_output_tokens**（FAX分の内訳。マイグレーション `add_fax_usage_breakdown`。2026-07-18） / updated_at。`add_api_usage()` 関数（service role 専用）で原子的に加算。FAX（添付PDF/画像の読取を伴う分類）は通常メールより入出力トークンが多く、将来的にFAXのみ上位モデル（Sonnet等）へ切り替える場合に単価を分けて試算できるよう内訳を分離して集計している（実際の切り替えは未実施。従量課金事項画面では「分類したメール」「分類したFAX」の件数を分けて表示）
> **是正済みの実装ミス（2026-07-18）**: `add_fax_usage_breakdown` で `add_api_usage()` を新しい引数構成（7個）で `create or replace` したところ、PostgreSQLは関数を名前＋引数シグネチャ単位で識別するため、既存の4引数版を置き換えず**別オーバーロードとして追加**されてしまった。新オーバーロードにはデフォルトのPUBLIC権限が付いたままで、`anon`/`authenticated` からも実行可能な状態になっていた（本システムの「anon/authenticatedは一切アクセス不可」という方針＝8章のC1是正に反する）。`get_advisors` 相当の確認で発覚し、旧4引数版を削除・新版の権限を `service_role` 限定に是正済み（`fix_add_api_usage_overload_grants`）。**教訓**: PL/pgSQL関数の引数を増減させる変更は `create or replace` だけでは既存関数を置き換えられないことがあるため、変更後は必ず `pg_proc`（`proacl`）で権限を確認する。

### push_subscriptions（2026-07-21。Web Push通知の購読情報）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid | `users.id` 参照（`on delete cascade`） |
| endpoint | text unique | ブラウザのインストールごとに一意。再購読時はこのキーで upsert |
| p256dh / auth | text | `PushSubscription.keys`。ペイロード暗号化（RFC 8291）に使う |
| created_at | timestamptz | |

`anon`/`authenticated` からは一切アクセス不可（service role のみ。他テーブルと同じ方針）。4-9参照。

### activity_logs（操作ログ）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| log_type | text | `fetch`（メール取得の実行結果） / `status_change`（ステータス変更） |
| actor | text | 実行者。担当者の表示名、または「システム（自動）」 |
| message | text | 画面表示用の内容 |
| detail | jsonb | 取得サマリー等の生データ |
| created_at | timestamptz | |

書き込み元: パイプライン（取得結果 + 返信検知の自動ステータス変更）、Worker の `PATCH /api/tasks`（担当者の手動ステータス変更時にサーバー側で記録）。いずれも service role 経由。60日より古いログはパイプライン実行時に自動削除。画面 `/logs`（操作ログ）で直近200件を参照。

### RLS / 権限設計（2026-07-16 に全面変更）
**anon・authenticated ロールには tasks・settings・activity_logs・api_usage への GRANT を一切与えていない**（RLSは有効のままポリシーも一切無し＝匿名は読み書き共に不可）。以前は「フロントは anon キーで直接読み取り、書き込みは status 列のみ anon 許可」としていたが、anon(publishable) キーは公開値であり、これは**認証なしで全顧客データが読める・改ざんできる致命的な脆弱性**だった（2026-07-15 セキュリティ審査で指摘・是正）。

- tasks・settings・activity_logs・api_usage への読み書きは**すべて Worker の `/api/*`（service role・JWT認証必須）経由**に統一
- users は従来どおり anon 向けポリシーを一切持たない（service role のみ）
- フロントエンドは匿名 Supabase クライアントを持たない（`src/lib/supabase.js` は削除済み）。`src/lib/tasks.js` は `authFetch` 経由で Worker を呼ぶ

---

## 6. 環境変数・シークレット

### Worker シークレット（GitHub Secrets からデプロイ時に自動同期）
| 名前 | 用途 |
|---|---|
| SUPABASE_URL / SUPABASE_SERVICE_KEY | service role 接続（URL は不正時にコード内の既知値へフォールバック） |
| SESSION_SECRET | JWT 署名鍵 |
| ANTHROPIC_API_KEY | Claude API |
| GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN | Gmail OAuth |
| VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT | Web Push通知の署名鍵（2026-07-21）。未設定の間は通知機能が無効のまま（デプロイは失敗しない）。`web-push-browser`パッケージの`generateVapidKeys`/`serializeVapidKeys`で生成した値。VAPID_SUBJECTは`mailto:`アドレス（無指定時は`eiwa.public@gmail.com`にフォールバック） |

### KV Namespace（`wrangler.jsonc` にバインド）
| バインディング名 | 用途 |
|---|---|
| LOGIN_ATTEMPTS | ログインのレート制限用。IP+ユーザー名ごとの失敗回数を記録（15分TTL） |

### CI 用
CLOUDFLARE_API_TOKEN（テンプレート「Edit Cloudflare Workers」）/ CLOUDFLARE_ACCOUNT_ID

> **2026-07-16 削除**: `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`（フロントエンド埋め込みの公開値）は、フロントが Supabase を直接読み書きしなくなったため不要になり削除した。

---

## 7. デプロイ・CI/CD

- main へ push → `.github/workflows/deploy.yml` が起動:
  1. `npm ci` → `npm run build`
  2. **Compute deploy message**: コミットメッセージから Version History 表示用の文言を作る（後述）
  3. **Deploy Worker**: `npx wrangler deploy --message="<コミットメッセージ本文>" --secrets-file="<一時JSON>"` を1回だけ実行し、**コード配布とシークレット同期を同一コマンド**で行う（2026-07-18に一本化。旧: 別ステップで `wrangler secret bulk` 相当を実行していたため、デプロイのたびに Version History にメッセージ無しの版がもう1つ増えていた）。**`--message=値`（=形式）にする理由（2026-07-21）**: squashマージ等でコミット本文が `- ` から始まる箇条書きになることがあり、`--message "値"`（空白区切り）だと wrangler(yargs) が値をオプションの値ではなく次の新しいフラグの開始と誤認し `Not enough arguments following: message` でデプロイが失敗した。ハイフンで始まり得る値をCLIフラグへ渡す際は空白区切りを避け `--flag=value` 形式にする
- 手動実行: Actions タブ →「Deploy to Cloudflare Workers」→ Run workflow
- **Version History 表示（2026-07-18）**: Cloudflare の Workers & Pages → Version History にデプロイのコミットメッセージが表示されるよう `--message` を指定している。
  - マージコミットの1行目「Merge pull request #N from owner/branch」はPRタイトルより先に表示されて読みにくいため、空行より後ろの本文（PRタイトル）だけを取り出して渡す（マージコミットでない場合は全文をそのまま使う）
  - `${{ github.event.head_commit.message }}` を `run:` のコマンド文字列に直接埋め込むとコマンドインジェクション/構文破壊の恐れがあるため、必ず `env:` 経由でシェル変数として渡す
  - `cloudflare/wrangler-action` の `command:` 入力はシェルを介さず引数分割されるため、`"$VAR"` を書いてもシェル変数として展開されない（実機で確認済みの既知の落とし穴）。そのため `wrangler` CLI を `run:` から直接呼び出している
- シークレットは `jq` でJSON化して `$RUNNER_TEMP`（ジョブ終了で消える領域）に書き出し、デプロイ後（失敗時含む）に明示的に削除する
- 設計上の注意（過去の障害から）:
  - `concurrency.cancel-in-progress` は **false**。デプロイの途中キャンセルは Worker のバージョン/シークレット不整合（error 10215）を起こし自己復旧できなくなるため、常に1本ずつ順番に処理する
- 不要 Worker の削除: Actions →「Delete Cloudflare Worker」で Worker 名を指定して実行

---

## 8. セキュリティ

2026-07-15 に外部セキュリティ審査を実施し、致命的1件・危険3件・注意7件を洗い出した。致命的・危険・注意のうちコードで対応できるものは 2026-07-16 にすべて修正・デプロイ済み（下記）。

### データ面へのアクセス（2026-07-16 全面刷新）
- **service role キー・API キー類は Worker シークレットのみに保持し、フロントエンドへは渡さない**（従来どおり）
- **フロントエンドは anon(publishable) キーによる Supabase 直接アクセスを一切行わない**。tasks/settings/activity_logs/api_usage への読み書きはすべて Worker の `/api/*`（service role・JWT必須）経由に統一した。以前は anon に SELECT（tasksはUPDATEも）を許可しており、anonキーは公開値のため**認証なしで全顧客データが読み書きできる致命的な脆弱性**だった（審査での指摘: C1）。修正後は Supabase 側で anon/authenticated への GRANT を全剥奪し、RLSポリシーも一切持たない状態にしている

### 認証・セッション
- ログインは bcrypt ハッシュ照合。ユーザー不在とパスワード不一致は同一メッセージ（存在推測の防止）
- **ログインのレート制限（2026-07-16追加）**: Cloudflare KV（`LOGIN_ATTEMPTS`）でIP+ユーザー名ごとの失敗回数を記録し、8回失敗で15分ロックアウト（429）。総当たり/辞書攻撃対策
- JWT は HS256・**30日**有効。サーバー側で署名検証、クライアント側は exp による自動ログアウト。加えて認証必須 API が 401 を返したらフロントが即ログアウトしてログイン画面へ誘導する
- **JWT失効機構（2026-07-16追加）**: `users.token_version` を発行時点のJWTへ `tv` として埋め込み、`verifyRequestAuth`（毎リクエスト）でDBの現在値と突合。不一致・DB参照失敗は無効扱い（フェイルクローズ）。パスワード変更・退職・トークン漏洩時は `token_version` をインクリメントするだけで、有効期限を待たずに当該ユーザーの全トークンを即時失効できる

### 添付ファイルAPI
- ログイン必須。共有アカウントの Gmail 認証情報（readonly）で取得し、フロントには渡さない
- **タスクスコープの限定（2026-07-16追加）**: `thread_id` を必須化し、①タスクに紐づくスレッドであること ②`message_id` がそのスレッドに実在すること、を検証してから取得する。以前は `message_id` の形式チェックのみで、タスク化されていない共有メールボックスの任意メッセージまで取得できた（審査での指摘: H3）

### レスポンス・通信
- Gmail は readonly スコープ。HTTPS は Cloudflare が終端
- **エラー詳細の非露出（2026-07-16追加）**: Supabase等の内部エラーメッセージをクライアントへそのまま返さず、汎用メッセージのみ返却。詳細は `console.error` でサーバーログにのみ出力（審査での指摘: N1）
- **セキュリティヘッダ/CSP（2026-07-16追加）**: 全レスポンス（API・静的アセット共通）に `X-Frame-Options: DENY` / `X-Content-Type-Options: nosniff` / `Referrer-Policy: strict-origin-when-cross-origin` / `Content-Security-Policy`（外部CDN等を使わないため、ほぼ全ディレクティブ `'self'`）を付与（審査での指摘: N2）。**`img-src`/`frame-src`のみ`blob:`を追加で許可**（2026-07-22。添付ファイルのアプリ内プレビュー機能が`URL.createObjectURL()`のBlob URLを`<img>`/`<iframe>`で表示するために必要。外部オリジンへの許可ではないため、この機能追加によるリスク増は無い）。**PDFプレビュー（preview_token経由）のレスポンスに限り`X-Frame-Options: SAMEORIGIN` / CSP`frame-ancestors 'self'`へ緩和**（2026-07-23。アプリ内PDFプレビューの同一オリジンiframe埋め込みを許可するため。`withSecurityHeaders`は既定で`DENY`/`frame-ancestors 'none'`を付与するが、このレスポンスのみ自オリジン限定に緩める。他サイトからのフレーム埋め込み＝クリックジャッキングは引き続き全面的に防止される）

### リポジトリ・鍵管理
- **リポジトリは非公開（Private）**（2026-07-16、審査での指摘 C2 に対応。従来は public だった）
- 公開リポジトリに含まれていた anon(publishable) キー（`sb_publishable_...`）は Supabase 側で削除済み。レガシーの `anon`/`service_role`（JWT形式）キーは公開されたことがなく、`service_role` はWorkerの稼働に必要なため意図的に未変更
- GitHub の Secret Protection / Push protection は有効化済み（確認済み）

### 残課題（運用ルール整備。コード変更なし）
審査の N3〜N7（Anthropicへの送信データ最小化の検討・秘密情報のローテーション運用・アカウント運用ルール・ログのPII保持ルール・依存関係の定期監査）は未着手。緊急性は低く、運用ルール化が中心。

---

## 9. コスト・無料枠

| サービス | 無料枠 | 利用見込み |
|---|---|---|
| Cloudflare Workers | 10万リクエスト/日・Cron 可・静的配信は無課金 | 社内3名 + Cron 288回/日 → 余裕で枠内 |
| Supabase | 500MB DB | テキストのみで枠内 |
| Gmail API | 無料 | — |
| Claude API (haiku) | 従量課金 | 1通あたり約0.3円。購入済み $5 で数か月分 |

- 稼働時間帯設定により時間外の起動を停止（Claude 費用はメール数比例のため総額はほぼ不変だが、無駄な実行を削減）
- 「従量課金事項」画面（旧・設定画面）の「今月の Anthropic API 利用状況」で自前計測ベースの推定コストを常時確認可能。2026-07-18より「分類したメール」「分類したFAX」の件数を分けて表示（FAXのみ将来的に上位モデルへ切り替える場合の単価別試算の準備。現状の推定コストはメール/FAX合算のまま）
- 残高不足は自動検知し、ダッシュボードに警告＋チャージ導線を表示
