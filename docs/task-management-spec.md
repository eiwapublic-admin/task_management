# タスク管理システム 仕様書・実装引き継ぎドキュメント

> **このドキュメントの目的**
> Claude Codeがゼロから実装を開始できるよう、要件・アーキテクチャ・環境構築手順・実装方針をまとめたものです。
> 開発・テストは個人 Claudeアカウントで行い、完了後に会社アカウントへ移管します。

---

## 1. プロジェクト概要

### 背景

- 社呡3名が共有の Gmailアカウントで業務メールを受信している
- メールをもとにしたタスク管理を自動化・可視化したい
- Gmailのみで完結しておらず、担当者への振り分けや進捗管理が必要

### ゴール

Gmail から業務メールを自動取得し、AI（Claude API）で担当者振り分け・期限抽出を行い、カンバン形式で進捗管理できる社内Webアプリを構築する。

---

## 2. 技術スタック

| 役割 | 採用技術 | 備考 |
|------|----------|------|
| フロントエンド | React (Vite) | カンバンUI / 設定画面 |
| バックエンド・DB | Supabase (PostgreSQL) | 無料枠で運用可能 |
| ホスティング | Netlify | 静的サイト + Scheduled Functions |
| メール取得 | Gmail API (OAuth 2.0) | 共有Gmailアカウントを対象 |
| AI処理 | Claude API (claude-haiku) | 振り分け・期限抽出・業務判定 |
| 認証 | カスタム認証 (Supabase Auth) | ユーザー/パスワード方式 |

---

## 3. 機能要件

### 3-1. メール取得と自動処理（30分ごと）

- Gmail API で未処理の受信メールを取得（既処理はスキップ）
- Claude API に本文を渡し、以下を一括判定：
  - **業務メールか否か**（業務外は無視）
  - **担当者の割り当て**（3名のうち誰寞か）
  - **期限の有無と日付**（「来週末」「今月中」などの曖昧表現も解釈）
  - **タスクタイトルの自動生成**（メール件名をベースに簡潔に要約）

### 3-2. タスクのステータス管理

ステータスは以下の4種類：

```
未処理 → 返信済み / 対応中 → 完了
```

| ステータス | 遷移条件 |
|-----------|---------|
| 未処理 | 業務メールを新規登録した初期状態 |
| 返信済み | 共有Gmailから該当スレッドへの返信を検知 → 自動遷移 |
| 対応中 | 担当者が手動で設定（または返信後に追加アクションがあった場合） |
| 完了 | 担当者のみが手動で設定（自動遷移なし） |

### 3-3. カンバン画面

- 4列のカンバン（ステータスごと）
- 各カードに表示する情報：
  - タスクタイトル
  - 担当者名
  - 期限（設定されている場合）
  - 受信日時
  - メール件名（折りたたみで全文参照可能）
- カード間でのドラッグ＆ドロップ、または手動ステータス変更ボタン
- 担当者でのフィルタリング機能

### 3-4. 返信自動検知

- 30分ごとの更新処理で、登録済みタスクのGmailスレッドを再確認
- スレッドの最新メールの `From` が共有アカウント（送信側）であれば「返信済み」に自動遷移
- すでに「対応中」「完了」のタスクは再遷移しない

### 3-5. 設定画面

- 更新頻度の変更（デフォルと30分、5分〜120分で設定可能）
- 担当者名の登録・変更（3名分）
- 業務判定のキーワードヒント入力（Claude APIへの追加コンテキスト）
- 設定はSupabaseのsettingsテーブルで管理

---

## 4. データベース設計（Supabase / PostgreSQL）

### テーブル一覧

#### `tasks` テーブル（メインのタスク情報）

```sql
CREATE TABLE tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_thread_id TEXT NOT NULL UNIQUE, -- Gmailスレッド識別子
  gmail_message_id TEXT NOT NULL,       -- 元メールのメッセージID
  title         TEXT NOT NULL,          -- AI生成タイトル
  assignee      TEXT NOT NULL,          -- 担当者名
  status        TEXT NOT NULL DEFAULT '未処理'
                CHECK (status IN ('未処理','返信済み','対応中','完了')),
  due_date      DATE,                   -- 期限（NULLの場合は期限なし）
  sender        TEXT NOT NULL,          -- 送信者メールアドレス
  subject       TEXT NOT NULL,          -- メール件名
  body_preview  TEXT,                   -- 本文プレビュー（最初の500文字）
  received_at   TIMESTAMPTZ NOT NULL,   -- 受信日時
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
```

#### `settings` テーブル（システム設定）

```sql
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 初期データ
INSERT INTO settings (key, value) VALUES
  ('fetch_interval_minutes', '30'),
  ('assignees', '["担当者A","担当者B","担当者C"]'),
  ('business_keywords', ''),
  ('shared_gmail', 'shared@example.com'),
  ('last_fetch_at', NULL);
```

#### `users` テーブル（認証用）

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- bcryptハッシュ
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

---

## 5. アーキテクチャ詳細

### 5-1. メール取得・処理フロー（Netlify Scheduled Function）

```
[Netlify Scheduled Function: /netlify/functions/fetch-emails.js]
   ↓ 30分ごとに実行
1. Supabaseの settings から last_fetch_at を取得
2. Gmail API で last_fetch_at 以降の受信メールを取得
3. 既にDBに存在するスレッドIDはスキップ
4. 新規メールをClaude APIに送信して以下をJSON形式で取得：
   - is_business_task: boolean
   - assignee: string
   - due_date: string | null (YYYY-MM-DD形式)
   - title: string
5. is_business_task = true のメールのみ tasks テーブルに INSERT
6. 既存タスクのスレッドを確認し、返信があれば status を '返信済み' に UPDATE
7. settings の last_fetch_at を現在時刻に更新
```

### 5-2. Claude APIへのプロンプト設計

```
システムプロンプト：
「あなたは業務メール分類アシスタントです。
担当者は [担当者A, 担当者B, 担当者C] の3名です。
以下のメールを分析し、必ずJSON形式のみで回答してください。

{
  "is_business_task": true/false,
  "assignee": "担当者名 or null",
  "due_date": "YYYY-MM-DD or null",
  "title": "タスクタイトル（20字以内）"
}

業務メールの判定基準：
- 取引先や顧客からの依頼・質問・連絡であればtrue
- 広告・ニュースレター・自動通知は false
```

### 5-3. フロントエンド構成（React）

```
src/
├── components/
│   ├── KanbanBoard.jsx     # カンバン全体
│   ├── KanbanColumn.jsx    # ステータス列
│   ├── TaskCard.jsx        # タスクカード
│   ├── TaskDetail.jsx      # カード詳細モーダル
│   ├── FilterBar.jsx       # 担当者フィルター
│   └── SettingsPanel.jsx   # 設定画面
├── pages/
│   ├── Login.jsx           # ログイン画面
│   ├── Dashboard.jsx       # カンバン画面
│   └── Settings.jsx        # 設定画面
├── lib/
│   ├── supabase.js         # Supabaseクライアント
│   └── auth.js             # 認証ヘルパー
└── App.jsx
```

---

## 6. 環境構築手順

### 手順１：Supabaseプロジェクト作成

1. https://supabase.com でプロジェクト作成（個人アカウント）
2. 上記「4. データベース設計」のSQLを SQL Editor で実行
3. 以下の値を控える：
   - `SUPABASE_URL`（例: https://xxxx.supabase.co）
   - `SUPABASE_ANON_KEY`

### 手順２：Gmail API の設定

1. https://console.cloud.google.com でプロジェクト作成
2. 「APIとサービス」→「APIを有効化」→ Gmail API を有効化
3. 「認証情報」→「OAuthクライアントID」を作成（アプリの種類：ウェブアプリケーション）
4. Netlifyのデプロイ後に Authorized redirect URI を追加
5. 以下の値を控える：
   - `GMAIL_CLIENT_ID`
   - `GMAIL_CLIENT_SECRET`
6. 初回のみ手動でリフレッシュトークンを取得（OAuth Playgroundを使用）
   - https://developers.google.com/oauthplayground/
   - スコープ: `https://www.googleapis.com/auth/gmail.readonly`
   - `GMAIL_REFRESH_TOKEN` を取得して控える

### 手順３：Claude API キー取得

1. https://console.anthropic.com でAPIキー発行
2. `ANTHROPIC_API_KEY` を控える
3. **モデルは `claude-haiku-4-5` を使用**（コスト最適化）

### 手順４：GitHubリポジトリ作成

```bash
git init task-management-app
cd task-management-app
# Vite + React でプロジェクト初期化
npm create vite@latest . -- --template react
npm install
npm install @supabase/supabase-js
```

### 手順５：Netlifyデプロイ設定

1. GitHubリポジトリをNetlifyに連携
2. ビルド設定：
   - Build command: `npm run build`
   - Publish directory: `dist`
3. 「Environment Variables」に以下を設定：

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJxxx...
SUPABASE_SERVICE_KEY=eyJxxx...  ← Scheduled Functionで使用（admin権限）
ANTHROPIC_API_KEY=sk-ant-xxx...
GMAIL_CLIENT_ID=xxx.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-xxx
GMAIL_REFRESH_TOKEN=1//xxx
SHARED_GMAIL_ADDRESS=shared@example.com
```

4. `netlify.toml` を作成：

```toml
[build]
  command = "npm run build"
  publish = "dist"

[[plugins]]
  package = "@netlify/plugin-functions-install-core"

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"

# 30分ごとに実行（cron式）
[[edge_functions]]
  path = "/api/fetch-emails"

[[plugins]]
  package = "@netlify/plugin-scheduled-functions"
```

---

## 7. 実装の優先順位（フェーズ分け）

> 進捗は 2026-07-01 時点。詳細な実装状況は「12. 実装状況・アーキテクチャ（as-built）」を参照。

### Phase 1：基盤構築（最初に実装）— ✅ 完了

- [x] Supabase テーブル作成
- [x] Netlify プロジェクト作成・デプロイ
- [x] ログイン画面（ユーザー/パスワード認証）
- [x] ダミーデータでのカンバン画面表示確認
- [x] （追加）UI/UXレビューに基づく改善（デザイントークン、a11y、レスポンシブ、セキュリティ堅牢化）

### Phase 2：メール連携（コア機能）— ✅ 実装完了（本番での実データ通し確認は保留）

- [x] Gmail API 接続（OAuthリフレッシュトークン方式、fetch直呼び）
- [x] Claude API 接続（業務判定・担当者振り分け・期限抽出・理由付与）
- [x] Netlify Scheduled Function 実装（fetch-emails.js、5分毎起動・settingsの間隔でゲート）＋手動実行（run-fetch.js）
- [x] 取得したメールのDB保存（業務メールのみ tasks へ INSERT）

### Phase 3：UI完成 — ✅ 完了

- [x] カンバンのステータス移動（ドラッグ＆ドロップ＋詳細モーダルのボタン、Supabaseへ永続化）
- [x] 担当者フィルター
- [x] タスク詳細モーダル（元メール本文＋AI判定の理由）
- [x] 設定画面（更新頻度・担当者名・業務背景/振り分けルール、Supabaseへ実保存）

### Phase 4：自動化・仕上げ — 🔶 一部完了

- [x] 返信自動検知ロジック実装（共有アドレス発の最新メールで「返信済み」へ自動遷移）
- [x] 更新頻度の設定反映（pipeline内で間隔ゲート）
- [x] （追加）APIクレジット不足の警告バナー＋今月の利用額表示
- [ ] 本番での実データ通し確認（Netlify無料枠リセット待ち＝2026-08-01）
- [ ] 本番環境（会社アカウント）への移管（下記「8. 移管手順」）

---

## 8. 移管手順（会社アカウントへの切り替え）

テスト完了後、以下の手順で会社アカウントに移管する。コード変更は不要。

| 対象 | 移管作業 |
|------|---------|
| Claude API | NetlifyのENV変数 `ANTHROPIC_API_KEY` を会社アカウントのキーに差し替え |
| Supabase | 会社アカウントでプロジェクト作成 → テーブル再作成 → ENV変数差し替え |
| Netlify | 会社アカウントにサイトを移管（または新規デプロイ） |
| Gmail API | 会社のGoogle CloudコンソールでOAuth設定 → ENV変数差し替え |
| リポジトリ | 会社のGitHub組織アカウントにリポジトリを移管 |

---

## 9. コスト試算

| サービス | 無料枠 | 想定コスト |
|---------|--------|-----------|
| Supabase | 500MB DB / 50MB ファイル | **無料枠内** |
| Netlify | 100GB帯域 / 125k関数実行/月 | **無料枠内** |
| Gmail API | 制限なし（個人用途） | **無料** |
| Claude API (Haiku) | 従量課金のみ | **月数百円程度**（1日50通×20日=1000通、1通あたり約0.3円想定） |

→ **実質的なランニングコストはClaude APIのみ（月数百円〜千円程度）**

> ⚠️ 2026-07 追記：Netlifyは「クレジット制」に移行しており、Free枠は **300 credits/月**（本番デプロイ≈15/回、AI inference等も消費）。**アプリ稼働分の消費は極小**だが、Netlify上でAIエージェント（Agent Runners）を回すと大きく消費する。詳細は「12. 実装状況・アーキテクチャ」を参照。

---

## 10. セキュリティ注意事項

- `SUPABASE_SERVICE_KEY`（管理者権限）はNetlifyの環境変数にのみ設定し、フロントエンドには絶対に渡さない
- フロントエンドには `SUPABASE_ANON_KEY` のみ使用し、Row Level Security (RLS) を有効にする
- Gmail のリフレッシュトークンは環境変数で管理し、コードにハードコードしない
- ログインセッションはJWTトークンをlocalStorageに保存（ブラウザの自動入力と併用）
- HTTPSはNetlifyが自動的に対応（Let's Encrypt）

---

## 11. Claude Codeへの作業開始指示

以下を Claude Code の最初のメッセージとして使用してください：

```
このドキュメント（task-management-spec.md）に従って、GmailベースのタスクManagementシステムを構築してください。

まずPhase 1から開始してください：
1. Vite + React のプロジェクト初期化
2. Supabase クライアントの設定
3. ログイン画面の実装
4. ダミーデータを使ったカンバン画面の表示確認

環境変数はすべて .env ファイルで管理し、.gitignoreに追加してください。
技術スタックは仕様書に記載のものを使用し、変更が必要な場合は事前に確認してください。
```

---

*作成日：2026年7月1日*

---

## 12. 実装状況・アーキテクチャ（as-built / 2026-07-03 更新）

> 本節は「当初仕様」に対する**実装の実態**をまとめたもの。新セッションへの詳細な引き継ぎは `docs/HANDOFF.md` を参照。

### 12-1. 実装済みの全体像
- **フロント（React + Vite）**: ログイン／カンバン（ダッシュボード）／設定。ダッシュボードはSupabaseから実データを取得し、ステータス変更を永続化。「今すぐ取得」ボタンで手動のメール取得を実行。設定画面で担当者・更新頻度・**業務背景/振り分けルール（org_context）**を編集し実保存。**今月のAPI利用状況（推定コスト）**を表示。
- **バックエンド（Netlify Functions, ESM v2）**:
  - `login.js`（POST `/api/login`）: bcrypt照合＋JWT発行。
  - `run-fetch.js`（POST `/api/run-fetch`, JWT保護）: 手動でパイプラインを即時実行。
  - `settings.js`（PUT `/api/settings`, JWT保護）: 許可キーのみ設定保存。
  - `fetch-emails.js`（Scheduled, `*/5 * * * *`）: settings の更新間隔でゲートしてパイプライン実行。
  - `lib/`: `gmail.js`（OAuth＋取得・本文抽出・スレッド最新From取得）、`anthropic.js`（分類＋usage返却＋残高不足検知）、`pipeline.js`（取得→分類→INSERT→返信検知→利用量加算→クレジット警告設定→last_fetch更新）、`supabase-admin.js`、`http.js`（JWT検証・JSON応答）。
- **DB（Supabase）**: `tasks`（`classification_note`・**`contact`（発信元の会社/担当者名）**列を追加）／`settings`（キー: fetch_interval_minutes, assignees, business_keywords, org_context, shared_gmail, api_credit_alert, last_fetch_at）／`users`／`api_usage`（月次トークン集計、`add_api_usage`関数）。RLSは「参照は許可、書き込みは service role 経由」。フロントの `tasks` 更新は**status列のみ**にGRANT制限。
- **分類ロジック**: `settings.org_context`（会社/担当者/取引先/BKB/本社/製品振り分け等の業務背景）をClaudeのシステムプロンプトに注入。**再デプロイ不要で設定画面から調整可能**。判定理由を `classification_note` に保存。分類の出力には `contact`（発信元の会社・担当者名。問い合わせフォームは本文の【会社名】【お名前】から抽出、社内メールは「（社内）」付き）を含む。
- **発信元表示**: タスクカードのタイトル直下と詳細モーダルに「発信元」を表示（`contact`。無ければ差出人 From にフォールバック）。

### 12-1b. 分類ルールの追記（org_context / 運用中に確定したもの）
- **實守紙業の「数量報告」の受付・確認は 西川 が担当**（org_context にルールとして追記済み）。
- **当社（栄和）発信が起点のスレッドは、状況に応じて 返信済み／対応中／完了 で登録する**（例：請求書送付済み＝完了、社内で担当者へ依頼済み＝対応中）。
  - ⚠️ この「発信元によるステータス自動判定」は**現状コードには未実装**。`pipeline.js` は常に `status='未処理'` でINSERTするため、当面は手動運用（またはMCP経由の手動抽出時に付与）。次セッションで **anthropic.js の出力に `status` を追加し pipeline で反映**する拡張が望ましい（次にやること参照）。
- **モデル**: `claude-haiku-4-5`（env `CLAUDE_MODEL` で上書き可）。

### 12-2. ホスティング・課金の実態
- **本番デプロイ対象ブランチ = `claude/task-management-system-ae752m`**（Netlifyの本番ブランチ設定）。ここにマージ＝本番URL `https://task-management-eiwa.netlify.app` に反映。開発作業ブランチは `claude/design-dev-review-0uerru`。
- **Netlify Free = 300 credits/月**（本番デプロイ≈15/回）。**アプリ稼働分の消費は極小**。2026-07は初期構築時のAI inference消費で枠を使い切り、**本番デプロイは 2026-08-01 の枠リセットまで停止**。ホスティング移行は不要と判断（Cloudflare/Supabase中心が予備案）。
- **Anthropic API**: Claude.aiサブスクとは**別会計**。$5チャージ済み。残高不足時はアプリが検知して警告バナー＋支払い画面リンクを表示。将来はオートリロードも選択肢。

### 12-2b. 共有アドレスの前提と運用ルール（2026-07-03 の重要な学び）
- 本システムが取得できるのは **`eiwa.public@gmail.com`（共有アドレス）に届いたメールのみ**。共有アドレスへの転送設定は 2026-07-01 前後にセットされたばかり。
- そのため、**担当者の個人アドレス（例 `nishikawa@eiwa-up.jp`）だけに届いた業務メールはシステムに載らない**。実際、テミス様・真砂住宅機器様・小泉産業 岡本様とのやりとりは個人宛で共有アドレスを経由しておらず、`eiwa.public@gmail.com` には存在しなかった（全期間検索で0件）。
- **運用ルール（要周知）**: 業務メールは共有アドレスを経由させる。方法は (1) 業務メールの宛先/CCに共有アドレスを含める、(2) 個人アドレスや特定相手からのメールを共有アドレスへ自動転送する。転送を追加すれば以後は自動で取得・分類される。
- 共有アドレスに実在する主な業務メール: 實守紙業の「数量報告」（毎週・2025年〜）、問い合わせフォーム（`if@eiwa-up.jp` 経由）、Secom設備点検、当社発の請求書送付など。小泉産業は福井・禿・中島の**古い(2023〜24年)**メールのみ。

### 12-2c. 現在の実データ（2026-07-03 時点、MCP経由で手動投入）
- 本番パイプライン（Netlify Functions）はサンドボックスから実行不可・本番も枠切れのため、**このセッションでは Gmail MCP＋Supabase MCP でパイプライン相当を手動再現**して `tasks` を投入した（Claude自身が分類。よって `api_usage` は未計上）。
- 現在の `tasks` は **6/22以降の共有アドレス実メールから5件**：
  1. 實守紙業 数量報告(6/23分) … 西川 / 未処理
  2. 實守紙業 数量報告(6/30分) … 西川 / 未処理
  3. 請求書送付（淀川勤労者厚生協会・ホログラム㈱ 宛）… 橋口 / **完了**（当社発信・送付済み）
  4. 関電来訪の対応（BKB地下電気室へ案内）… 岡田 / **対応中**（当社=西川発信の社内依頼）
  5. ニッケルセンサー価格お問い合わせ … 橋口 / 未処理（顧客発）
- UI（発信元表示・ステータス別カラム）はローカルビルド＋Playwrightでスクリーンショット確認済み。ブラウザからの実閲覧は 2026-08-01 の本番復旧後（評価アカウント `hyoka` でログイン可）。

### 12-3. 現在のブロッカー / 次にやること
1. **2026-08-01 のNetlify枠リセット後**に本番反映（自動デプロイ or Trigger deploy）→ 30分毎の自動取得が有効化。
2. **「当社発信→ステータス自動判定」を実装**: `anthropic.js` の出力に `status`（未処理/返信済み/対応中/完了）を追加し、`pipeline.js` の INSERT で反映（現状は常に未処理でINSERTのため手動運用）。
3. メールを溜めてから「今すぐ取得」→ データを増やして**別の社員にも評価**してもらう（評価アカウント `hyoka` は作成済み）。
4. 実データでの通し確認（ログイン→取得→分類→返信検知）。分類結果を見て `org_context` を調整。
5. **業務メールを共有アドレス経由にする運用の徹底**（12-2b）。個人宛のみの取引先は転送設定を追加。
6. 会社アカウントへの移管（§8）。
7. **資格情報のローテーション**（初期引き継ぎ資料に平文の秘密情報が含まれていたため推奨）。

*次のアクション：`docs/HANDOFF.md` を読み、2026-08-01のNetlify枠リセット後に本番反映と実データ評価を行う。*
