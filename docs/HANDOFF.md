# タスク管理システム 引き継ぎ文書（新セッション用）

最終更新: 2026-07-01 / 対象リポジトリ: `eiwapublic-admin/task_management`

> この文書はリポジトリ内に置かれた「正」の引き継ぎです。新しいセッションは本リポジトリを取得し、
> `docs/task-management-spec.md`（仕様・as-built）と本ファイルを最初に読んでください。
> **秘密情報（APIキー・パスワード・トークン）は本文書に一切含めません。** それらは Netlify の環境変数と各サービスのコンソールにあります。

---

## 0. まず読む順番
1. `docs/task-management-spec.md` … 要件＋「12. 実装状況・アーキテクチャ（as-built）」
2. 本ファイル `docs/HANDOFF.md` … 現状・運用・次アクション
3. `supabase/schema.sql` … DBスキーマ（正）

---

## 1. 現状サマリー（2026-07-01）
- **Phase 1（基盤）・Phase 2（メール連携）・Phase 3（UI）実装完了**。Phase 4（自動化・仕上げ）は返信検知・利用額表示まで完了、**実データ通し確認は保留**。
- **ブロッカー**: Netlify無料枠を使い切り、**本番デプロイが 2026-08-01 の枠リセットまで停止**。コード・DB・設定はすべて反映済みで、枠回復後に本番反映すれば動く状態。
- **Anthropic API**: $5チャージ済み（Claude.aiサブスクとは別会計）。
- 会社の業務背景（栄和／担当者3名／取引先 小泉産業 等）は `settings.org_context` に投入済みで、分類プロンプトへ注入される。

## 2. アーキテクチャ
- フロント: React 19 + Vite（`/`=カンバン, `/login`, `/settings`）。`RequireAuth` が `isAuthenticated()`（localStorageのJWT有効期限）でガード。
- 認証: 独自認証（Supabase Auth不使用）。`users` テーブルに bcrypt ハッシュ。ログインAPIが SESSION_SECRET でJWT発行（7日）。フロントは localStorage 保管。
- バックエンド: Netlify Functions（ESM v2: `export default` + `export const config`）。DBは Supabase（PostgreSQL）。
- AI分類: Anthropic Messages API（`claude-haiku-4-5`）を fetch で直呼び。
- メール取得: Gmail API（OAuth2 リフレッシュトークン方式）を fetch で直呼び。
- ホスティング: Netlify（GitHub連携で自動デプロイ、Scheduled Functions）。

## 3. リポジトリ構成（主要）
```
docs/task-management-spec.md      # 仕様＋as-built
docs/HANDOFF.md                   # 本ファイル
supabase/schema.sql               # DBスキーマ（tasks/settings/users/api_usage, RLS, 関数）
netlify.toml                      # build/functions/SPAリダイレクト
netlify/functions/
  login.js                        # POST /api/login
  run-fetch.js                    # POST /api/run-fetch（JWT保護・手動取得）
  settings.js                     # PUT /api/settings（JWT保護・設定保存）
  fetch-emails.js                 # Scheduled（*/5）→ pipeline
  lib/
    pipeline.js                   # 取得→分類→INSERT→返信検知→利用量加算→クレジット警告→last_fetch
    gmail.js                      # OAuth/一覧/本文抽出/スレッド最新From
    anthropic.js                  # 分類（usage返却・残高不足検知）
    supabase-admin.js             # service roleクライアント
    http.js                       # JWT検証 / JSON応答
src/
  pages/ Login.jsx / Dashboard.jsx / Settings.jsx
  components/ KanbanBoard/Column/TaskCard/TaskDetail/FilterBar/SettingsPanel/UsagePanel(.jsx,.css)
  lib/ auth.js / supabase.js / tasks.js / api.js / status.js / format.js / pricing.js
```

## 4. ブランチ運用（重要）
- **開発作業ブランチ**: `claude/design-dev-review-0uerru`（ここで開発・push）。
- **本番デプロイ対象ブランチ**: `claude/task-management-system-ae752m`（Netlifyの Production branch 設定）。ここにマージ＝本番URLへ反映。
- 反映手順（fast-forward可能な想定）:
  ```
  git checkout -B claude/task-management-system-ae752m origin/claude/task-management-system-ae752m
  git merge --ff-only claude/design-dev-review-0uerru
  git push -u origin claude/task-management-system-ae752m
  git checkout claude/design-dev-review-0uerru
  ```
- push は `git push -u origin <branch>`、ネットワーク失敗時は指数バックオフで最大4回リトライ。
- 本番URL: `https://task-management-eiwa.netlify.app` / ブランチデプロイ: `https://<branch-slug>--task-management-eiwa.netlify.app`

## 5. DBスキーマ要点（Supabase project: `pfiogfdnbctunkhslmcp`）
- `tasks`: gmail_thread_id(unique)/gmail_message_id/title/assignee/status(未処理|返信済み|対応中|完了)/due_date/sender/subject/body_preview/**classification_note**/received_at。
- `settings`(key,value): `fetch_interval_minutes`,`assignees`(JSON配列),`business_keywords`,`org_context`,`shared_gmail`,`api_credit_alert`,`last_fetch_at`。
- `users`: username/password_hash(bcrypt)/display_name。フロントからは一切アクセス不可（service roleのみ）。
- `api_usage`(month PK, input_tokens, output_tokens, calls): 月次トークン集計。関数 `add_api_usage(month,input,output,calls)` で原子的に加算（service roleがrpc）。
- RLS方針: `tasks`/`settings`/`api_usage` は参照(select)許可。書き込みは service role 経由。フロント(anon)の `tasks` 更新は **status列のみ** にGRANT制限（INSERT/DELETE/他列は不可）。
- スキーマ変更は Supabase MCP の `apply_migration` で本番へ直接適用してきた。変更時は `supabase/schema.sql` も必ず更新。

## 6. メール処理パイプライン（pipeline.js）
1. `settings` 読込（間隔・担当者・org_context・shared_gmail・last_fetch_at）。
2. 更新間隔ゲート（手動実行=force時は無視）。
3. Gmail: `in:inbox after:<last_fetch epoch>`（初回は `newer_than:1d`）で新着取得、最大40件。既存スレッドIDはスキップ。
4. 各メールを Claude で分類 → `is_business_task=true` のみ tasks へ INSERT（担当者が不明/範囲外なら先頭の担当者に既定割当、due_dateはYYYY-MM-DD検証）。
5. 返信検知: status='未処理' のタスクのスレッド最新Fromが `shared_gmail` を含めば '返信済み' に更新。
6. 利用量を `add_api_usage` で月次加算。クレジット不足検知時は `settings.api_credit_alert` を設定、正常分類時は解除。
7. `last_fetch_at` 更新。
- クレジット不足はフロントのダッシュボードで赤バナー＋支払い画面リンク（`console.anthropic.com/settings/billing`）として表示。

## 7. 環境変数（Netlifyに設定済み・値は載せない）
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SESSION_SECRET`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`(任意), `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`。
- ※ `shared_gmail`（共有アドレス）は settings テーブルで管理（返信検知に使用）。
- ⚠️ Netlifyで `is_secret: true` を付けると**ブランチデプロイで値が注入されない**罠あり。現状は全て `is_secret:false`・スコープall。

## 8. 外部サービス（管理場所。キー/値は各コンソールで確認）
- Supabase: project `pfiogfdnbctunkhslmcp`（tasks/settings/users/api_usage）。MCPツールで操作可。
- Netlify: site `task-management-eiwa`。本番ブランチ設定・環境変数・デプロイはダッシュボードで。MCP読み取り可（本番ブランチ切替APIは無い→ダッシュボード or マージ運用）。
- Anthropic Console: APIキー・クレジット残高・支払い。組織/ワークスペースがキーと一致していること。
- Gmail: 共有アドレス `eiwa.public@gmail.com`。OAuth同意画面が「テスト中」の間、**リフレッシュトークンは約7日で失効**する点に注意（継続運用なら本番公開を検討）。

## 9. 課金・運用メモ
- **Netlify**: Free=300 credits/月。本番デプロイ≈15/回。アプリ稼働分は極小。2026-07は枠切れ→**8/1リセットで本番デプロイ復旧**。評価は当面ブランチ/プレビュー＋「今すぐ取得」で可能。**Agent Runners（NetlifyでAIエージェントを回す機能）は大量消費**するので開発はNetlify上で回さない。
- **Anthropic**: 1通あたり約0.5〜0.8円（Haiku）。返信検知はGmailのみでAPI不使用。残高ゼロだと分類失敗（警告バナー）。
- 会社負担化: APIキー発行元を会社のAnthropic組織へ、Netlifyも会社アカウントへ（§8移管手順）。個人のClaude.aiサブスクは運用に不要（解約可）。

## 10. 開発・検証の進め方
- ローカル表示検証: `npm run build && npx vite preview --port 4173` → Playwright(`playwright-core`, chromium `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`)でスクショ。protectedページは localStorage にダミーJWTを注入して描画。実データ表示は `src/lib/tasks.js`/`api.js` を一時モックに差し替え、検証後 `git checkout -- ...` で戻す（コミットしない）。
- ビルド/静的検査: `npm run build` / `npm run lint`(oxlint)。
- サンドボックスのegressプロキシは外部ドメインへの直curlを制限することがある → 動作確認はブラウザ/本番 or ブランチデプロイで。

## 11. 次にやること（優先順）
1. **2026-08-01 Netlify枠リセット後**に本番反映（自動 or Trigger deploy）→ 自動取得(30分毎)有効化。
2. メールを溜めて「今すぐ取得」→ データ増加 → **別の社員にも評価**（必要なら `users` に評価用アカウント追加）。
3. 分類結果を見て `settings.org_context`（振り分けルール）を調整。
4. （任意）オートリロード or 月予算しきい値での事前警告。
5. 会社アカウントへ移管、資格情報ローテーション。

## 12. 制約・約束事
- 秘密情報はリポジトリ/コミット/PR/コメントに書かない。
- PRはユーザーが明示的に依頼した場合のみ作成。
- 破壊的・外向きの操作（本番切替・DB破壊的変更・外部送信）は事前確認。
