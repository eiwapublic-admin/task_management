# タスク管理システム

Gmail から業務メールを自動取得し、Claude API で担当者振り分け・期限抽出を行い、カンバン形式で進捗管理する社内Webアプリ。

技術スタック: React (Vite) / Supabase (PostgreSQL) / Netlify (Hosting + Scheduled Functions) / Gmail API / Claude API

詳細仕様は [`docs/task-management-spec.md`](./docs/task-management-spec.md) を参照してください。

## 現在の実装状況（Phase 1）

- [x] Vite + React プロジェクト初期化
- [x] Supabase クライアント設定（`src/lib/supabase.js`）
- [x] ログイン画面（`src/pages/Login.jsx` + `netlify/functions/login.js`）
- [x] ダミーデータでのカンバン画面（`src/components/KanbanBoard.jsx` ほか）
- [ ] Gmail API 連携（Phase 2）
- [ ] Claude API 連携（Phase 2）
- [ ] 返信自動検知・設定反映（Phase 4）

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. 環境変数の設定

`.env.example` を `.env` にコピーし、値を埋めてください（`.env` は git 管理外）。

```bash
cp .env.example .env
```

| 変数名 | 用途 |
|---|---|
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | フロントエンドから Supabase に接続（公開可） |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Netlify Functions から admin 権限で接続（非公開・サーバー専用） |
| `SESSION_SECRET` | ログインセッション用トークンの署名鍵（ランダムな長い文字列） |
| `ANTHROPIC_API_KEY` / `GMAIL_*` | Phase 2 で使用 |

### 3. Supabase プロジェクトの準備

`supabase/schema.sql` を Supabase の SQL Editor で実行し、`tasks` / `settings` / `users` テーブルを作成してください。
`users` テーブルへの初期ユーザー登録は、`password_hash` に bcrypt ハッシュを設定して行ってください。

### 4. ローカル開発

```bash
npm run dev
```

Netlify Functions（ログインAPIなど）も含めて動かす場合は [Netlify CLI](https://docs.netlify.com/cli/get-started/) を使用してください。

```bash
npx netlify dev
```

### 5. Netlify へのデプロイ

1. このリポジトリを Netlify サイトに接続
2. Build command: `npm run build` / Publish directory: `dist`（`netlify.toml` に設定済み）
3. Site settings → Environment variables に `.env.example` の非公開値（`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SESSION_SECRET` など）を設定
