# タスク管理システム 設計書（Cloudflare 版）

最終更新: 2026-07-05
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
| 認証 | カスタム認証（bcrypt + HS256 JWT） | JWT は Web Crypto による自前実装 |
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
    ├── gmail.js        Gmail API 軽量クライアント（fetch 直叩き・依存なし）
    ├── anthropic.js    Claude API クライアント（分類プロンプト・JSON抽出・課金エラー検知）
    ├── supabase-admin.js  service role クライアント（URL不正時はフォールバック）
    ├── jwt.js          HS256 JWT の署名・検証（Web Crypto）
    └── http.js         JSONレスポンス・Bearer トークン検証ヘルパー
src/
├── pages/              Login / Dashboard（カンバン）/ Settings
├── components/         KanbanBoard, KanbanColumn, TaskCard, TaskDetail,
│                       FilterBar, SettingsPanel, UsagePanel
└── lib/                supabase(anon), auth, api, tasks, format, status, pricing
public/
├── logo.svg            栄和ロゴ（原本 logo_black.svg を赤 #c81021 で塗ったもの）
└── logo_black.svg      ロゴ原本（枠線のみ）
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
   - `assignee`: 担当者（settings の3名から。不明時は先頭の担当者）
   - `due_date`: 期限（「来週末」等の相対表現も JST 基準で YYYY-MM-DD に変換）
   - `title`: タスクタイトル（30字以内で自動生成）
   - `sender_display`: 送信元の会社名・氏名（**問い合わせフォーム経由は本文の記載を優先**）
   - `sender_email`: 返信先メールアドレス（フォーム経由は本文記載のアドレスを優先。取れない場合は Reply-To → From にフォールバック）
   - `reason`: 判定理由（振り分けルール調整の参考用に保存）
5. 業務メールのみ tasks に INSERT（ステータス「未処理」）
6. **返信検知**（2方式。いずれも「未処理」→「返信済み」へ自動遷移）:
   - **件名ベース**: 受信メールの件名（Re: 等を除去して正規化）が未処理タスクと一致し、差出人が自社側（共有アドレス or `company_domains` のドメイン）または宛先が元の送信者なら返信とみなす（Claude 分類はスキップ＝コスト節約）。担当者が自分のメーラーから返信し CC の社内 ML 経由で共有アドレスに配信されたケースを拾う
   - **スレッドベース**: タスクのスレッド最新メールの差出人が自社側なら返信とみなす
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
- タイトル「栄和　タスク管理システム」(22px)。右側に「今すぐ取得」（白）「設定」（青）「ログアウト」（黒）
- ログインユーザー名は担当者フィルターと同じ行の右端に大きめ（17px）に表示
- 4列カンバン（列背景はステータス色を薄く混ぜた濃いめの色）。ステータス名 16px
- タスクカード: タイトル / 送信元（👤 会社名・氏名。旧データは From 表示名で代替）/ 担当者アバター / 期限（超過・間近バッジ）/ 受信日時 / 件名（折りたたみ）
- 担当者フィルター（チップ、15px）。ドラッグ＆ドロップでステータス変更（anon キーは status 列のみ更新可）
- タスク詳細モーダル（幅560px）: タイトル+×は固定ヘッダー、最下部は固定フッタ。フッタ左に「ステータス」見出し＋変更ボタン、右に「メール参照」「返信」ボタン
  - **メール参照**: Gmail のウェブ画面で該当メールを開く（`https://mail.google.com/mail/u/<共有アドレス>/#all/<gmail_message_id>`。共有アカウントへのログインが必要）
  - **返信**: `mailto:` でメーラーの返信画面を開く。TO=タスクの返信先アドレス（フォーム経由は本文記載のアドレス）、CC=`if@eiwa-up.jp`（固定。同アドレス宛は共有 Gmail にも配信されるため返信検知の対象になる）、本文に元メールを引用
- クレジット不足時は警告バナー＋「APIクレジットをチャージ」ボタン

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
| POST `/api/login` | 不要 | bcrypt 照合 → HS256 JWT（7日有効）を発行 |
| POST `/api/run-fetch` | JWT | パイプラインを force=true で即時実行 |
| PUT `/api/settings` | JWT | 許可キーのみ settings に upsert（service role 経由） |
| その他 | — | dist/ の静的アセット（SPA フォールバック） |

settings の許可キー: `fetch_interval_minutes`, `active_hours_start`, `active_hours_end`, `assignees`, `business_keywords`, `org_context`, `shared_gmail`, `company_domains`

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
| subject / body_preview | text | body_preview は先頭500字 |
| classification_note | text | AI の判定理由 |
| received_at / created_at / updated_at | timestamptz | updated_at はトリガーで自動更新 |

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
- JWT は HS256・7日有効。サーバー側で署名検証、クライアント側は exp による自動ログアウトのみ
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
