# 引き継ぎ書（Cloudflare 版・本番稼働中）

最終更新: 2026-07-05
設計の詳細は [`task-management-spec-cloudflare.md`](./task-management-spec-cloudflare.md) を参照。

---

## 1. 現在の状態

- **本番 URL**: https://task-management.eiwa-public.workers.dev
- **稼働状況**: 全機能開通済み（ログイン → Gmail 取得 → Claude 分類 → カンバン登録 → 返信自動検知 → 5分ごとの Cron）。実メールでのタスク登録を確認済み
- **リポジトリ**: `eiwapublic-admin/task_management`（デフォルトブランチ main）
- **Cloudflare**: Worker 名 `task-management`（アカウントに残す Worker はこの1つだけ）
- **Supabase**: プロジェクト `Eiwapublic Project`（ref: `pfiogfdnbctunkhslmcp`, region: ap-southeast-2）。スキーマ・マイグレーション適用済み
- **Anthropic**: $5 クレジット購入済みのアカウントの API キーで稼働（モデル: claude-haiku-4-5）

### 経緯の要約

1. 当初 Netlify で構築予定 → Netlify 側 AI 機能で無料枠を消費し中断
2. Cloudflare Workers に移行（Supabase・フロントエンドはそのまま流用、Netlify Functions は `worker/` に移植）
3. Gmail リフレッシュトークンを再発行し全機能開通（OAuth アプリは「本番」公開済み）
4. UI 刷新（ロゴ・グリーンヘッダー・カンバン配色・設定画面2カラム等）と機能追加（稼働時間帯・送信元表示・API 利用量表示）

---

## 2. 日常運用

### 運用でやること
- 基本は放置でよい。メールは稼働時間帯（既定 8〜18時 JST）に設定した頻度（既定30分）で自動取得される
- 振り分け精度の調整: 設定画面の「業務背景・振り分けルール（org_context）」を編集して保存（**再デプロイ不要**、次回取得から反映）。各タスク詳細の「AI判定の理由」が調整の参考になる
- ユーザー追加: Supabase の `users` テーブルに `username / password_hash(bcrypt) / display_name` を INSERT

### コスト監視
- 設定画面下部「今月の Anthropic API 利用状況」で推定コストを確認
- クレジット残高が尽きると分類が止まり、ダッシュボードに赤い警告バナー＋チャージ導線が出る。チャージ後「今すぐ取得」で再開

---

## 3. 開発・デプロイ手順

### コード変更 → 本番反映
main ブランチに push（または PR をマージ）するだけ。GitHub Actions が「ビルド → wrangler deploy → シークレット同期」を自動実行する。手動実行は Actions タブ →「Deploy to Cloudflare Workers」→ Run workflow。

### シークレットの変更（例: Gmail トークン再発行時）
1. GitHub リポジトリ → Settings → Secrets and variables → Actions で値を更新
2. Actions から Deploy ワークフローを1回実行（デプロイ時に Worker へ同期される）

### 登録済み GitHub Secrets 一覧
| Secret | 用途 |
|---|---|
| CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID | CI からのデプロイ |
| VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY | フロントビルド埋め込み（公開値） |
| SUPABASE_URL / SUPABASE_SERVICE_KEY | Worker → Supabase（service role） |
| SESSION_SECRET | JWT 署名鍵 |
| ANTHROPIC_API_KEY | Claude API |
| GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN | Gmail OAuth |

※ `VITE_SUPABASE_URL` / `SUPABASE_URL` は正しくは `https://pfiogfdnbctunkhslmcp.supabase.co`。過去に不正な値が入っていたため、コード側で「URL として不正なら既知の本番値にフォールバック」する防御を入れてある（`src/lib/supabase.js` / `worker/lib/supabase-admin.js`）。Secrets を正しい値に直すのが望ましい。

### ローカル開発
```bash
npm install
cp .env.example .env       # フロント用
cp .env.example .dev.vars  # wrangler dev 用（git 管理外）
npm run build && npm run dev:worker   # http://localhost:8787（API込み）
```

### DB スキーマ変更
`supabase/schema.sql` を更新（IaC として正を維持）し、同じ SQL を Supabase の SQL Editor か MCP の migration で適用する。

---

## 4. 障害対応の知見（実際に起きたもの）

| 症状 | 原因 | 対処 |
|---|---|---|
| 画面が真っ白 | ビルド時の `VITE_SUPABASE_URL` が URL 形式でなく `createClient` が例外 | フォールバック実装済みで再発しない。Secrets の値も正しておく |
| 「Gmail トークン取得に失敗 (400) invalid_grant」 | リフレッシュトークン失効。**OAuth 同意画面が「テスト」だと7日で失効する** | Google Cloud Console でアプリを「本番」に公開（対応済み）。再発時は OAuth Playground で再取得 → Secret 更新 → Deploy 実行 |
| デプロイ失敗 error 10215（Secret edit failed） | デプロイの途中キャンセル等で「未デプロイの新バージョン」が残ると、シークレット同期が先に走る構成では自己復旧できない | 対策済み: ワークフローを「deploy → secrets」の2段階化 + `cancel-in-progress: false`。もし再発したら Deploy を再実行すれば直る |
| OAuth 認可時「このアプリは Google で確認されていません」 | 未審査アプリの標準警告 | 「詳細」→「（安全でないページ）に移動」で続行してよい（自社アプリ） |

### ログの見方
- **アプリ内の操作ログ**: メイン画面ヘッダーの「ログ」→ 操作ログ画面。メール取得の実行結果とタスクのステータス変更履歴を実行者（担当者名 or システム（自動））付きで確認できる。直近200件表示・60日で自動削除
- Worker の実行ログ: Cloudflare ダッシュボード → Workers & Pages → task-management → Logs（observability 有効化済み）
- デプロイログ: GitHub Actions の各 run
- スケジュール実行の結果は `scheduled fetch 完了: {...}` として JSON サマリーが出る（skipped の理由も記録される）

---

## 5. 会社アカウントへの移管手順（未実施）

コード変更は不要。以下の載せ替えのみ。

1. **GitHub**: リポジトリを会社 org へ移管（Actions の Secrets は移管先で再登録）
2. **Cloudflare**: 会社アカウントで API トークン/アカウント ID を発行し Secrets を差し替え → Deploy 実行（新アカウント側に Worker が作られる。URL のサブドメインが変わる点に注意）
3. **Supabase**: 会社アカウントでプロジェクト作成 → `supabase/schema.sql` を適用 → users を再登録 → SUPABASE 系 Secrets 差し替え
4. **Anthropic**: 会社アカウントの API キーに `ANTHROPIC_API_KEY` を差し替え
5. **Gmail**: 会社の Google Cloud で OAuth クライアント作成 →「本番」公開 → リフレッシュトークン取得 → GMAIL 系 Secrets 差し替え

---

## 6. 残タスク・改善候補

- [ ] GitHub Secrets の `VITE_SUPABASE_URL` / `SUPABASE_URL` を正しい URL に修正（動作はフォールバックで問題なし）
- [ ] 実運用での振り分け精度を見ながら org_context を調整
- [ ] 会社アカウントへの移管（上記 5 章）
- [ ] （任意）ロゴを原本の配色で使いたい場合は `public/logo.svg` を差し替え（原本の枠線版は `public/logo_black.svg` に保管済み）
