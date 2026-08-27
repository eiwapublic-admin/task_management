# 障害復旧手順書（バックアップと再構築）

このシステム（タスク管理システム / `eiwapublic-admin/task_management`）が失われた場合に
作り直すための手順と、そのために必要な備え。

> **結論: Git だけでは再構築できない。**
> コードは Git にあるが、**シークレット・各サービスの設定・DBのデータ**は Git に無い。
> 「Git + データバックアップ + この手順書 + パスワードマネージャ」の4点が揃って初めて復旧できる。

導入の経緯: 2026-08-25、日報データ移行事故で本番データ（日報9日分・違反車両）を誤削除した際、
Supabase 無料プランのためバックアップ復元ができず、FileMaker側の近似データで日報部分のみ
部分復旧するしかなかった（`docs/HANDOFF.md` 経緯の要約 148番）。この再発防止として、
2026-08-27 に本ドキュメントと `.github/workflows/backup.yml` を導入した。

---

## 1. 何がどこにあるか

| 対象 | 保管場所 | 失われたときの影響 |
|---|---|---|
| アプリのコード | GitHub `eiwapublic-admin/task_management` | 大（作り直し） |
| DBのスキーマ・データ | **GitHub `eiwapublic-admin/task_management-backups`（毎日自動）** | 致命的 |
| 認証ユーザー | `users` テーブル（`public.users`。カスタム認証・bcrypt）。`data.sql` に含まれる | 全員が再登録に |
| シークレット類 | **パスワードマネージャ（要・人手で管理）** | 再発行で対応可 |
| Supabase の各種設定 | Supabase ダッシュボードのみ → 本書 §4 | 中（手作業で再設定） |
| Cloudflare（ホスティング）側の設定 | Cloudflare ダッシュボードのみ → 本書 §5 | 中（手作業で再設定） |
| Storage のファイル本体（`report-photos` バケット） | Supabase Storage のみ（バケット定義は`schema.sql`で復元されるが中身は無い） | 中（日報・違反車両・備品署名の写真が失われる） |

**Supabase の無料プランには自動バックアップが無い**（Pro以上のみ）。公式ドキュメントでも
無料プランは `db dump` で自分でエクスポートしオフサイト保管することが推奨されている。
また **プロジェクトを削除すると、Supabase 側のバックアップも含めて完全に消える**。

> 補足: このアプリは Supabase Auth（`auth.users`）を使わず、独自の `public.users` テーブル +
> bcrypt によるカスタム認証を採用している（`docs/HANDOFF.md` 参照）。そのためログイン復元に
> 必須なのは `data.sql`（`public.users` を含む）であり、`auth_data.sql` は現状ほぼ空のはずだが、
> 汎用テンプレートに合わせて同じ3ファイル構成のまま残している。

---

## 2. 毎日のバックアップ（自動）

`.github/workflows/backup.yml` が毎日 JST 03:00 に実行され、
プライベートリポジトリ `eiwapublic-admin/task_management-backups` に以下をコミットする。

| ファイル | 内容 |
|---|---|
| `schema.sql` | テーブル・RLSポリシー・関数・トリガ・権限（**再構築の土台**） |
| `data.sql` | 業務データ（public スキーマ。`public.users` のログイン情報を含む） |
| `auth_data.sql` | Supabase Auth のユーザー（`auth.users` / `auth.identities`。未使用のため通常は空） |

取得には **`pg_dump` を直接**使う（Supabase CLI は使わない）。CLI は `pg_dump` を
コンテナ内で実行する際に接続URLを解析し直すため、**Session pooler 用のユーザー名
`postgres.<project-ref>` が `postgres` に落ちて認証に失敗する**。

- **世代管理は Git の履歴そのもの。** 「3日前の状態」は `git show HEAD~3:data.sql` で取り出せる。
  保存期間の上限が無いため、法定保存年数などの要件にも対応できる。
- 内容に変更が無い日はコミットされない。実行の記録は GitHub の Actions のログに残る。
- **アプリの「ログ」画面（`/logs`）にも `バックアップ` 種別で結果が記録される**
  （`log_type='backup'`。2026-08-27 のマイグレーション `allow_backup_activity_log_type` で
  `activity_logs.log_type` の制約に `backup` を追加済み）。
- **副次効果**: 毎日実DB接続することで、Supabase 無料プランの「7日間アクセスが無いと一時停止」も
  同時に回避できる（専用の keep-alive pingは不要になる）。
- **失敗すると GitHub からオーナー宛にメールが届く。** 届いたら放置しないこと。

### 初回セットアップ（未実施。要手動作業）

このセッションから `eiwapublic-admin/task_management-backups` の自動作成を試みたが、
GitHub App が組織へのリポジトリ作成権限を持っておらず失敗した（`404 Not Found`）。
以下は人手で1回だけ行う必要がある。

1. GitHub で **private** リポジトリ `eiwapublic-admin/task_management-backups` を作成
   （コードは置かない。バックアップ専用）
2. https://github.com/settings/personal-access-tokens で fine-grained PAT を発行
   - Repository access: Only select repositories → 上記の `task_management-backups` のみ
   - Permissions → Repository permissions → **Contents: Read and write**
   - Expiration は1年など有期限にする（ワークフローの「トークンの有効期限を確認」ステップが
     残り30日を切ると警告してくれる）
3. `eiwapublic-admin/task_management` の Settings > Secrets and variables > Actions に登録:
   - `SUPABASE_DB_PASSWORD` … Supabase の DB パスワード（そのまま。URLエンコード不要。
     Supabase ダッシュボード → Project Settings → Database で確認・リセット可能）
   - `BACKUP_REPO_TOKEN` … 手順2で発行した PAT
4. Actions タブ →「Daily backup」→ Run workflow で一度手動実行し、成功すること・
   `task_management-backups` にコミットが入ること・`/logs` 画面に「バックアップ」の行が
   増えていることを確認する

### バックアップ用トークンの再発行（有効期限が来たら）

`BACKUP_REPO_TOKEN` には有効期限がある（既定1年）。**切れるとバックアップが静かに止まる**。

1. https://github.com/settings/personal-access-tokens で古いトークンを開く
   - **「Regenerate token」**があればそれが最短（権限設定を引き継げる）
2. 新規作成の場合: Repository access は `task_management-backups` のみ、
   Permissions → Contents: Read and write
3. `eiwapublic-admin/task_management` の Settings > Secrets and variables > Actions で
   `BACKUP_REPO_TOKEN` を更新
4. Actions から手動実行し、成功すること・警告が消えることを確認

### 必要な Secrets（このリポジトリの Settings > Secrets and variables > Actions）

| 名前 | 値 |
|---|---|
| `SUPABASE_DB_PASSWORD` | Supabase のDBパスワード（そのまま。URLエンコード不要） |
| `BACKUP_REPO_TOKEN` | `task_management-backups` へ push できる Personal Access Token |

> ⚠️ **Session pooler のユーザー名は `postgres.pfiogfdnbctunkhslmcp`。**
> ただし **`password authentication failed for user "postgres"` というエラーからは原因を判別できない。**
> Session pooler はプロジェクトを識別したあと内部では `postgres` として認証するため、
> ユーザー名を正しく送っていても文言は常に `user "postgres"` になる。
> このエラーが出たら、パスワード・ユーザー名・**接続URLを解析し直すツール（Supabase CLI）**の
> いずれかを疑うこと。ワークフローには接続テストのステップがあるので、
> そこで通るかどうかで資格情報の問題かダンプ側の問題かを切り分けられる。
> また **直結（`db.pfiogfdnbctunkhslmcp.supabase.co`）は使えない**（GitHub Actions は IPv4 で、
> Supabase の直結は IPv4 だと有料アドオンが必要）。**Transaction pooler（6543）では `pg_dump` が
> 動かない**ため、必ず **5432 の Session pooler** を使う。

---

## 3. データを復元する

```bash
git clone https://github.com/eiwapublic-admin/task_management-backups.git
cd task_management-backups
# 特定の日付に戻したい場合は git log で探して checkout する

# 新しい Supabase プロジェクトの接続文字列に対して流し込む
# 順序は必ず schema → auth_data → data。data.sql が auth.users を参照する外部キーを
# 持つため、auth_data.sql より先に data.sql を流すと外部キー制約違反で失敗する。
psql "<新プロジェクトの接続文字列>" -f schema.sql
psql "<新プロジェクトの接続文字列>" -f auth_data.sql
psql "<新プロジェクトの接続文字列>" -f data.sql
```

`schema.sql` 実行時に出る以下のエラーは想定内（空のプロジェクトでも発生する）なので無視してよい。

- `schema "public" already exists`（新規プロジェクトには最初から `public` スキーマがあるため）
- `permission denied to change default privileges`（pooler接続ユーザーはスーパーユーザーではないため。
  Supabase側の既定権限で運用上は問題ない）

**復元後に必ず確認すること**

- ユーザーがログインできる（`public.users` が入っているか。カスタム認証のため `auth.users` ではない）
- カンバン・日報・備品など主要な画面でデータが正しく表示される
- `settings` テーブルの各設定値（`org_context` / `company_domains` / `calendar_name` 等）が
  入っているか

---

## 4. Supabase を作り直す場合の設定（Git に無い）

新しいプロジェクトを作ったら、以下を**手作業で**再設定する。

1. **Authentication > URL Configuration**: Site URL / Redirect URLs
   （このアプリはカスタム認証で Supabase Auth のログインフローを使わないため、
   実際に必要になるかは要確認。念のため本番URLに合わせておく）
2. **Storage**: `report-photos` バケットの定義は `schema.sql` に含まれるが、**中の写真ファイルは
   含まれない**（日報・違反車両・備品テナント署名の写真）。必要なら別途バックアップするか、
   失われた前提で運用する
3. 新しい Project URL・service role key をホスティング側（Cloudflare Workers の Secrets、
   `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`）に反映する（本書 §5・`docs/HANDOFF.md` 3章参照）

---

## 5. ホスティング（Cloudflare Workers）を作り直す場合の設定（Git に無い）

`docs/HANDOFF.md` 5章「会社アカウントへの移管」により詳しい手順があるため、そちらも参照。

1. Cloudflare アカウントで API トークン・Account ID を発行
2. GitHub Secrets（`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`）を設定
3. `main` への push（または Actions から `Deploy to Cloudflare Workers` を手動実行）で
   `.github/workflows/deploy.yml` が Worker をデプロイし、他の全 Secrets（Supabase・Gmail・
   Anthropic・VAPID・備品API等。`docs/HANDOFF.md` 3章「登録済み GitHub Secrets 一覧」参照）を
   同期する
4. デプロイ後、新しい Worker の URL を確認し、Gmail OAuth の設定等に影響が無いか確認する

---

## 6. パスワードマネージャに保管しておくもの

以下は**どこにも自動保存されていない**。人が保管する必要がある。

- Supabase の **DBパスワード**（`SUPABASE_DB_PASSWORD` と同じ値）
- Supabase の **service role key**（`SUPABASE_SERVICE_KEY` と同じ値）
- GitHub の **Personal Access Token**（`BACKUP_REPO_TOKEN`。再発行も可能）
- Gmail OAuth のクライアントID/シークレット・リフレッシュトークン
- Anthropic API キー
- Supabase / Cloudflare / GitHub の各アカウント情報

---

## 7. 定期的に確認すること

- [x] **年1回**、バックアップから実際に復元できるか試す（無料プロジェクトをもう1つ作って流し込む）。
      **試していないバックアップは、あると思い込んでいるだけで存在しないのと同じ。**
      2026-08-25 の事故時点ではこの復元ドリルが未実施だったため、実際に詰まった。
      **2026-08-27、本稼働開始前に前倒しで初回実施し、主要18テーブル全件が本番と一致することを
      確認済み**（`docs/HANDOFF.md` 182番）。次回は1年後を目安に再実施すること。
- [ ] **年1回**、Cloudflare Workers 側も別アカウントで実際にデプロイできるか試す
- [ ] バックアップの Actions が失敗していないか（失敗時はメールが届く。アプリの `/logs` 画面でも
      「バックアップ」種別を確認できる）
- [ ] `BACKUP_REPO_TOKEN` の期限が近くないか
- [ ] Supabase の無料プロジェクトは **7日間アクセスが無いと一時停止**する
      （毎日のバックアップが実DB接続を発生させるので、通常は自動的に回避される）

---

## 8. 既知の課題

- `supabase/migrations/` に相当するものは無く、`supabase/schema.sql` をIaCの正としている
  （`docs/HANDOFF.md` 3章「DB スキーマ変更」参照）。ダッシュボードから直接適用した変更は
  記録に残らないことがあるため、再構築には必ず**バックアップの `schema.sql`**を使うこと。
- `report-photos` バケットの写真本体はこのバックアップ対象外（本書 §1・§4）。将来的に必要性が
  高まれば、Storage の定期エクスポートも検討する。
