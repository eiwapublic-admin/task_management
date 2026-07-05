# 引き継ぎドキュメント（Cloudflare 移行版）

最終更新: 2026-07-05

## 経緯

- 当初は Netlify でホスティングする計画だったが、初期構築時に Netlify 側の AI 機能で無料枠を消費してしまい中断。
- **Cloudflare Workers（無料プラン）に移行**。Supabase プロジェクトはそのまま流用する。
- 1つの Worker で「静的サイト配信（Vite ビルド成果物）+ API（/api/*）+ Cron Triggers（定期メール取得）」をすべて賄う構成。Netlify Functions のコードは `worker/` に移植済みで、ロジックは同一。

## 無料枠での運用

| サービス | 無料枠 | 本システムの利用量 |
|---|---|---|
| Cloudflare Workers | 10万リクエスト/日、Cron Triggers 利用可、静的アセット配信は無制限・無課金 | 社内3名 + 5分ごとの Cron（288回/日）→ 余裕で枠内 |
| Supabase | 500MB DB | 枠内（テキストのみ） |
| Gmail API | 無料 | — |
| Claude API (claude-haiku-4-5) | 従量課金 | 購入済み $5 クレジットで数か月分（1通あたり約0.3円） |

## アーキテクチャ

```
[Cloudflare Worker: task-management]
 ├─ fetch ハンドラ
 │   ├─ POST /api/login      … カスタム認証（bcrypt照合 → HS256 JWT発行）
 │   ├─ POST /api/run-fetch  … 手動即時取得（要ログイン）
 │   ├─ PUT  /api/settings   … 設定保存（要ログイン、service role 経由）
 │   └─ その他              … dist/ の静的アセット（SPAフォールバック付き）
 └─ scheduled ハンドラ（cron: */5 * * * *）
     └─ runPipeline: Gmail取得 → Claude分類 → Supabase保存 → 返信検知
        （実際の取得間隔は settings.fetch_interval_minutes でゲート）
```

- JWT は Workers 互換のため `jsonwebtoken` を廃止し、Web Crypto API による自前実装（`worker/lib/jwt.js`）に置き換え済み。トークン仕様（HS256・7日有効）は従来と同じ。
- `nodejs_compat` フラグにより `process.env` / `Buffer` をそのまま使用（既存パイプラインコードを無改変で流用）。

## 初回セットアップ（1回だけの手動作業）

自動デプロイのために、以下を GitHub リポジトリの **Settings → Secrets and variables → Actions → Secrets** に登録する。

| Secret 名 | 取得元 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare ダッシュボード → My Profile → API Tokens → Create Token → テンプレート「**Edit Cloudflare Workers**」 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare ダッシュボード → Workers & Pages 画面右側の Account ID |
| `VITE_SUPABASE_URL` | Supabase → Project Settings → API（公開値） |
| `VITE_SUPABASE_ANON_KEY` | 同上（anon/publishable キー。公開値） |
| `SUPABASE_URL` | `VITE_SUPABASE_URL` と同じ値 |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API → service_role キー（**非公開**） |
| `SESSION_SECRET` | ランダムな長い文字列（例: `openssl rand -hex 32`） |
| `ANTHROPIC_API_KEY` | console.anthropic.com（$5 クレジット購入済みのアカウント） |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | Google Cloud Console の OAuth クライアント |
| `GMAIL_REFRESH_TOKEN` | OAuth Playground で取得（scope: gmail.readonly） |

登録後、`main` ブランチに push（または Actions タブから「Deploy to Cloudflare Workers」を手動実行）すると：

1. フロントエンドをビルド（Supabase の公開値を埋め込み）
2. `wrangler deploy` で Worker + 静的アセット + Cron Trigger をデプロイ
3. 上記の非公開値を Worker のシークレットとして自動同期

以後は push のたびに全自動でデプロイされる。公開 URL は `https://task-management.<サブドメイン>.workers.dev`（初回デプロイ後の Actions ログまたは Cloudflare ダッシュボードで確認）。

## Supabase 側

- 既存プロジェクトをそのまま利用。スキーマ変更なし（`supabase/schema.sql` が最新）。
- 未実行の場合は SQL Editor で `supabase/schema.sql` を実行。
- ログインユーザーの追加は `users` テーブルに bcrypt ハッシュで INSERT する。

## Netlify からの変更点まとめ

| 項目 | Netlify 版 | Cloudflare 版 |
|---|---|---|
| API | `netlify/functions/*.js`（個別関数） | `worker/index.js`（単一 Worker でルーティング） |
| 定期実行 | Scheduled Functions | Cron Triggers（`wrangler.jsonc` の `triggers.crons`） |
| SPA フォールバック | `netlify.toml` の redirects | `assets.not_found_handling: "single-page-application"` |
| JWT | `jsonwebtoken`（Node 依存） | Web Crypto 自前実装（`worker/lib/jwt.js`） |
| デプロイ | Netlify の Git 連携 | GitHub Actions + `wrangler-action` |
| 環境変数 | Netlify の ENV 設定 | GitHub Secrets → デプロイ時に Worker シークレットへ自動同期 |

フロントエンド（`src/`）と Supabase スキーマは無変更。

## 残タスク

- [ ] GitHub Secrets の登録（上記表 → 登録後に Actions を1回実行）
- [ ] 初回デプロイ後、workers.dev URL でログイン〜手動取得〜カンバン表示を確認
- [ ] Gmail OAuth のリフレッシュトークンが有効か確認（テストアプリ状態だと7日で失効するため、Google Cloud Console で「本番」へ公開しておく）
- [ ] 運用が安定したら会社アカウントへの移管（spec 8章の手順は Netlify → Cloudflare に読み替え）
