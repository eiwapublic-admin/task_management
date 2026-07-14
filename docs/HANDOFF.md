# 引き継ぎ書（Cloudflare 版・本番稼働中）

最終更新: 2026-07-06
設計の詳細は [`task-management-spec-cloudflare.md`](./task-management-spec-cloudflare.md) を参照。

---

## 1. 現在の状態

- **本番 URL**: https://task-management.eiwa-public.workers.dev
- **稼働状況**: 全機能開通済み（ログイン → Gmail 取得 → Claude 分類 → カンバン登録 → 返信自動検知 → 5分ごとの Cron）。実メールでのタスク登録を確認済み
- **リポジトリ**: `eiwapublic-admin/task_management`（デフォルトブランチ main）
- **Cloudflare**: Worker 名 `task-management`（アカウントに残す Worker はこの1つだけ）
- **Supabase**: プロジェクト `Eiwapublic Project`（ref: `pfiogfdnbctunkhslmcp`, region: ap-southeast-2）。スキーマ・マイグレーション適用済み
- **Anthropic**: $5 クレジット購入済みのアカウントの API キーで稼働（モデル: claude-haiku-4-5）

### Google カレンダー連携（開通済み）
- Gmail と同じ Google アカウント（eiwa.public@gmail.com）の「栄和共通」カレンダー（＝このアカウントのメインカレンダー）の**当日イベント**を、毎回の取得時にタスク化（未処理）する。イベントのタイトル・詳細をそのまま登録し、詳細に「担当：〜」（「担当者：」も可）があればその担当者を割り当てる。ステータス進行は手動
- 取得対象は settings の `calendar_name`。現在は**カレンダーID `eiwa.public@gmail.com` を直接指定**している（`@` を含む値は ID として直接使う。表示名でも指定可だが下記の経緯によりID指定が確実）
- **設定に必要だった前提（再構築時の参考）**:
  1. **OAuth スコープ**: リフレッシュトークンに `calendar.readonly` が必要。OAuth Playground で「Use your own OAuth credentials」に自社の Client ID/Secret を入れ、gmail.readonly と calendar.readonly の両方を選んで認可 → 発行された Refresh token（`1//`始まり）を `GMAIL_REFRESH_TOKEN` に更新 → Deploy
  2. **Google Cloud プロジェクトで Calendar API を有効化**（Gmail API とは別に有効化が必要）
  3. **カレンダーIDの特定**: 「栄和共通」は副カレンダーではなくメインカレンダーの表示名だったため、ID はメールアドレス `eiwa.public@gmail.com`。表示名「栄和共通」では calendarList から解決できず、ID 直接指定で解決した。カレンダーIDはカレンダー設定の「カレンダーの統合」で確認できる
- カレンダーが見つからない場合、操作ログに「利用可能なカレンダー: …」と購読中カレンダー名の一覧が出るので、名前の食い違い/未共有の切り分けに使える

### 経緯の要約

1. 当初 Netlify で構築予定 → Netlify 側 AI 機能で無料枠を消費し中断
2. Cloudflare Workers に移行（Supabase・フロントエンドはそのまま流用、Netlify Functions は `worker/` に移植）
3. Gmail リフレッシュトークンを再発行し全機能開通（OAuth アプリは「本番」公開済み）
4. UI 刷新（ロゴ・グリーンヘッダー・カンバン配色・設定画面2カラム等）と機能追加（稼働時間帯・送信元表示・API 利用量表示）
5. タスク詳細に「メール参照」（Gmail を開く）「返信」（mailto、TO=返信先 / CC=if@eiwa-up.jp 固定・元メール引用付き）を追加
6. 操作ログ（activity_logs テーブル + /logs 画面）を追加。メール取得結果とステータス変更を実行者付きで記録
7. 返信検知を2方式に拡張（件名ベース + スレッドベース、自社ドメイン `company_domains` 発も検知）。返信検知時はタスク本文を返信内容で置き換え、判定理由に追記。誤検知ガード（元メッセージ自体・元差出人の追加送信は除外）も導入済み
8. UI・運用の改善（2026-07-09）: 「対応中」列を薄い黄色に / 画面の自動更新（5分間隔 + タブ復帰時。バックエンド取り込み後の再読込を明示操作なしで反映）/ 自社→社外への新規送信メールは初めから「返信済み」で登録 / 担当者を特定できない場合は先頭担当者ではなく「（担当未設定）」にしてオレンジ警告表示
9. 機能追加（2026-07-09）: タスクの手動登録（未処理列の「＋」ボタン）/ 自動登録分を含む担当者・期限の編集（詳細画面）/ 「留意事項」フィールド（`tasks.remarks`）を詳細画面で入力可能に

---

## 2. 日常運用

### 運用でやること
- 基本は放置でよい。メールは稼働時間帯（既定 8〜18時 JST）に設定した頻度（既定30分）で自動取得される
- 振り分け精度の調整: 設定画面の「業務背景・振り分けルール（org_context）」を編集して保存（**再デプロイ不要**、次回取得から反映）。各タスク詳細の「AI判定の理由」が調整の参考になる
- ユーザー追加: Supabase の `users` テーブルに `username / password_hash(bcrypt) / display_name` を INSERT
- 登録済みユーザー: `nishikawa`（西川）/ `okada`（岡田）/ `kaz`（橋口）/ `hyoka`（評価ユーザー）
- 自社ドメインの変更: settings の `company_domains`（カンマ区切り、既定 `eiwa-up.jp`）。このドメイン発のメールは「自社からの返信」として返信検知に使われる
- 操作の確認: メイン画面「ログ」→ 操作ログ画面（取得結果・ステータス変更を実行者付きで表示）

### コスト監視
- 設定画面下部「今月の Anthropic API 利用状況」で推定コストを確認
- クレジット残高が尽きると分類が止まり、ダッシュボードに赤い警告バナー＋チャージ導線が出る。チャージ後「今すぐ取得」で再開

### アプリの更新（PWA）
- 本アプリは PWA 化済み。デプロイのたびに Service Worker（`SW_VERSION` = git SHA を刻印）が更新され、開いている端末には**「新しいバージョンがあります → 更新」バナー**が出る（最大1分間隔のチェック or 再訪時）。ロゴをタップしても明示的に最新化できる
- ヘッダーの `ver.YYYY-MM-DD HH:MM`（JST）はビルド時刻。端末が最新デプロイを取得できているかの確認に使う（表示は更新検知とは独立）
- SW はキャッシュを一切行わない最小構成（`fetch` ハンドラ無し）で、通常利用は常に最新が配信される。ホーム画面に追加すればアプリのように起動できる

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

※ `VITE_SUPABASE_URL` / `SUPABASE_URL` は正しくは `https://pfiogfdnbctunkhslmcp.supabase.co`。過去に不正な値が入っていたため、コード側で「URL として不正なら既知の本番値にフォールバック」する防御を入れてある（`src/lib/supabase.js` / `worker/lib/supabase-admin.js`）。Secrets は 2026-07-06 に正しい値へ修正済み（フォールバックは保険として残置）。

### ローカル開発
```bash
npm install
cp .env.example .env       # フロント用
cp .env.example .dev.vars  # wrangler dev 用（git 管理外）
npm run build && npm run dev:worker   # http://localhost:8787（API込み）
```

### DB スキーマ変更
`supabase/schema.sql` を更新（IaC として正を維持）し、同じ SQL を Supabase の SQL Editor か MCP の migration で適用する。
- 直近の追加列: `tasks.remarks`（留意事項。詳細画面で手動入力。マイグレーション `add_remarks_to_tasks` 適用済み）

### タスクの手動登録・編集 API（Worker）
- フロントの anon キーは RLS で **status 列の更新のみ**許可。担当者・期限・留意事項の編集や手動登録は Worker の `/api/tasks`（service role）経由で行う。
  - `POST /api/tasks`: 手動登録（未処理列の「＋」）。`gmail_thread_id`/`gmail_message_id` は `manual:<uuid>`、`source='manual'`
  - `PATCH /api/tasks`: `assignee` / `due_date` / `remarks` / `title` を更新
- いずれもログイン必須（JWT）。

---

## 4. 障害対応の知見（実際に起きたもの）

| 症状 | 原因 | 対処 |
|---|---|---|
| 画面が真っ白 | ビルド時の `VITE_SUPABASE_URL` が URL 形式でなく `createClient` が例外 | フォールバック実装済みで再発しない。Secrets の値も正しておく |
| 「Gmail トークン取得に失敗 (400) invalid_grant」 | リフレッシュトークン失効。**OAuth 同意画面が「テスト」だと7日で失効する** | Google Cloud Console でアプリを「本番」に公開（対応済み）。再発時は OAuth Playground で再取得 → Secret 更新 → Deploy 実行 |
| デプロイ失敗 error 10215（Secret edit failed） | デプロイの途中キャンセル等で「未デプロイの新バージョン」が残ると、シークレット同期が先に走る構成では自己復旧できない | 対策済み: ワークフローを「deploy → secrets」の2段階化 + `cancel-in-progress: false`。もし再発したら Deploy を再実行すれば直る |
| OAuth 認可時「このアプリは Google で確認されていません」 | 未審査アプリの標準警告 | 「詳細」→「（安全でないページ）に移動」で続行してよい（自社アプリ） |
| 担当者がメーラーから返信したのに「返信済み」にならない | 旧検知は共有アドレス発の返信のみ対象だった | 対応済み: 件名ベース検知 + 自社ドメイン（company_domains）発の検知を追加（PR #16） |
| 返信していないタスクが「返信済み」になる（誤検知） | 社内発・フォームシステム発のメールは From が自社ドメインのため、返信ゼロのスレッドでも「最新=自社発」に合致 | 対応済み: 元メッセージ自体と元差出人の追加送信を除外（PR #18）。誤遷移したタスクは手動で 未処理 に戻し、操作ログに補正を記録する |
| 別顧客の新規フォーム送信で既存フォームタスクが「返信済み」になる（誤検知） | 問い合わせフォーム由来メールは件名が定型（例:「ホームページからのお問い合わせ」）で共通し From も自社ドメイン（if@eiwa-up.jp）のため、件名ベース検知が「件名一致＋From が自社」だけで別件を返信と誤判定 | 対応済み: 件名ベース検知に「宛先が元の顧客（counterpart）を含む」ことを必須化（正当な返信は必ず顧客宛て）。To に加え Cc も判定対象に |
| タスク本文プレビューに元メールに無い引用マーク「> / ＞」が付く | 返信検知で本文を返信メールの内容に置き換える際、引用行の行頭マークをそのまま転記していた | 対応済み: `compactBody` で行頭引用マーク（半角/全角・ネスト）と不可視文字（BOM・ゼロ幅スペース）を除去。既存タスクの body_preview も一括クレンジング済み |
| 「メール参照」で Gmail が Temporary Error (404) | URL パスに `/u/<アドレス>` を埋め込む形式が原因 | 対応済み: `?authuser=` クエリ形式に変更（PR #14） |
| カレンダー取得が「参照の権限がありません（Insufficient Permission）」 | トークンに calendar スコープが無い | OAuth Playground で gmail+calendar 両スコープで再発行 → Secret 更新 → Deploy |
| カレンダー取得が 403「Calendar API has not been used / disabled」 | Google Cloud プロジェクトで Calendar API 未有効化 | Cloud Console で Google Calendar API を有効化し数分待つ |
| カレンダー取得が「カレンダー『〜』が見つかりません」 | 表示名で解決できない（メインカレンダーはメール名で返る等） | 操作ログの「利用可能なカレンダー」一覧を確認し、`calendar_name` にカレンダーID（メールアドレス or `〜@group.calendar.google.com`）を直接設定する |

### ログの見方
- **アプリ内の操作ログ**: メイン画面ヘッダーの「ログ」→ 操作ログ画面。メール取得の実行結果とタスクのステータス変更履歴を実行者（担当者名 or システム（自動））付きで確認できる。直近200件表示・60日で自動削除
- Worker の実行ログ: Cloudflare ダッシュボード → Workers & Pages → task-management → Logs（observability 有効化済み）
- デプロイログ: GitHub Actions の各 run
- スケジュール実行の結果は `scheduled fetch 完了: {...}` として JSON サマリーが出る（skipped の理由も記録される）

---

## 5. 会社アカウントへの移管（完了）

2026-07-13 完了。運用は会社の各アカウント（GitHub `eiwapublic-admin` / Cloudflare / Supabase `Eiwapublic Project` / Gmail `eiwa.public@gmail.com` / Anthropic）で稼働しており、開発・運用に用いる Claude アカウントも同日に会社アカウント（`eiwa.public@gmail.com`）へ乗り換え済み。以降、外部アカウントへの載せ替え作業は不要。

（参考）別アカウントへ改めて載せ替える場合の手順。コード変更は不要で、以下の差し替えのみ。

1. **GitHub**: リポジトリを会社 org へ移管（Actions の Secrets は移管先で再登録）
2. **Cloudflare**: 会社アカウントで API トークン/アカウント ID を発行し Secrets を差し替え → Deploy 実行（新アカウント側に Worker が作られる。URL のサブドメインが変わる点に注意）
3. **Supabase**: 会社アカウントでプロジェクト作成 → `supabase/schema.sql` を適用 → users を再登録 → SUPABASE 系 Secrets 差し替え
4. **Anthropic**: 会社アカウントの API キーに `ANTHROPIC_API_KEY` を差し替え
5. **Gmail**: 会社の Google Cloud で OAuth クライアント作成 →「本番」公開 → リフレッシュトークン取得 → GMAIL 系 Secrets 差し替え

---

## 6. 残タスク・改善候補

- [x] GitHub Secrets の `VITE_SUPABASE_URL` / `SUPABASE_URL` を正しい URL に修正（2026-07-06 対応済み）
- [ ] 実運用での振り分け精度を見ながら org_context を調整
- [ ] 返信検知の精度を実運用で観察（誤検知・検知漏れがあれば操作ログとタスクの「AI判定の理由」を手がかりに調整）
- [x] 会社アカウントへの移管（2026-07-13 完了。上記 5 章）
- [ ] （任意）ロゴを原本の配色で使いたい場合は `public/logo.svg` を差し替え（原本の枠線版は `public/logo_black.svg` に保管済み）
