# タスク管理システム

Gmail から業務メールを自動取得し、Claude API で担当者振り分け・期限抽出を行い、カンバン形式で進捗管理する社内Webアプリ。

技術スタック: React (Vite) / Supabase (PostgreSQL) / **Cloudflare Workers**（静的ホスティング + API + Cron Triggers）/ Gmail API / Claude API

- 詳細仕様: [`docs/task-management-spec.md`](./docs/task-management-spec.md)（※ホスティングは Netlify → Cloudflare に変更済み）
- セットアップ・引き継ぎ手順: [`docs/HANDOFF.md`](./docs/HANDOFF.md)

## 実装状況

- [x] Vite + React プロジェクト初期化・ログイン画面・カンバン画面
- [x] Gmail API 連携（取得・返信検知）
- [x] Claude API 連携（業務判定・担当者振り分け・期限抽出）
- [x] 定期実行（Cloudflare Cron Triggers、5分ごと起動 + settings の間隔でゲート）
- [x] Cloudflare Workers への自動デプロイ（GitHub Actions）
- [ ] 本番運用開始・会社アカウントへの移管

## 構成

```
worker/index.js       Cloudflare Worker（/api/* ルート + scheduled ハンドラ）
worker/lib/           Gmail / Claude / Supabase / パイプライン処理
src/                  React フロントエンド（Vite）
supabase/schema.sql   DB スキーマ（Supabase SQL Editor で実行）
wrangler.jsonc        Worker 設定（静的アセット・Cron・SPAフォールバック）
.github/workflows/deploy.yml  main への push で自動デプロイ
```

## ローカル開発

```bash
npm install
cp .env.example .env       # フロントエンド用の値を設定
cp .env.example .dev.vars  # wrangler dev 用（非公開値を設定。git管理外）
npm run build              # フロントエンドをビルド（dist/）
npm run dev:worker         # API 込みの動作確認（http://localhost:8787）
```

フロントエンドのみを触る場合は `npm run dev`（Vite。/api は使えません）。

## デプロイ

`main` に push すると GitHub Actions が自動でビルド・デプロイします（手動作業なし）。
初回のみ GitHub Secrets の設定が必要です → [`docs/HANDOFF.md`](./docs/HANDOFF.md) 参照。
