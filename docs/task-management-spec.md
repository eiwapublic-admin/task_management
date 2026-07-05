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

### Phase 1：基盤構築（最初に実装）

- [ ] Supabase テーブル作成
- [ ] Netlify プロジェクト作成・デプロイ
- [ ] ログイン画面（ユーザー/パスワード認証）
- [ ] ダミーデータでのカンバン画面表示確認

### Phase 2：メール連携（コア機能）

- [ ] Gmail API 接続テスト（トークン取得・メール一覧取得）
- [ ] Claude API 接続テスト（業務判定・担当者振り分け）
- [ ] Netlify Scheduled Function 実装（fetch-emails.js）
- [ ] 取得したメールのDB保存

### Phase 3：UI完成

- [ ] カンバンのステータス移動（ドラッグ＆ドロップ or ボタン）
- [ ] 担当者フィルター
- [ ] タスク詳細モーダル（元メール本文の確認）
- [ ] 設定画面（更新頻度・担当者名変更）

### Phase 4：自動化・仕上げ

- [ ] 返信自動検知ロジック実装
- [ ] 更新頻度の設定反映
- [ ] テスト・動作確認
- [ ] 本番環境（会社アカウント）への移管

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
*次のアクション：Claude Codeで上記「11. 作業開始指示」を実行し、Phase 1の実装を開始する」
