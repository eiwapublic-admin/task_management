# 障害復旧手順書（バックアップと再構築）— テンプレート

このシステムが失われた場合に作り直すための手順と、そのために必要な備え。
アプリごとに `<...>` を埋め、実情に合わせて §4/§5 のプラットフォーム手順を書き換えること。

> **結論: Git だけでは再構築できない。**
> コードは Git にあるが、**シークレット・各サービスの設定・DBのデータ**は Git に無い。
> 「Git + データバックアップ + この手順書 + パスワードマネージャ」の4点が揃って初めて復旧できる。

---

## 1. 何がどこにあるか

| 対象 | 保管場所 | 失われたときの影響 |
|---|---|---|
| アプリのコード | GitHub `<owner>/<app>` | 大（作り直し） |
| DBのスキーマ・データ | **GitHub `<owner>/<app>-backups`（毎日自動）** | 致命的 |
| 認証ユーザー（auth.users） | 同上（`auth_data.sql`） | 全員が再登録に |
| シークレット類 | **パスワードマネージャ（要・人手で管理）** | 再発行で対応可 |
| Supabase の各種設定 | Supabase ダッシュボードのみ → 本書 §4 | 中（手作業で再設定） |
| ホスティング側の設定 | ホスティングのダッシュボードのみ → 本書 §5 | 中（手作業で再設定） |
| Storage のファイル本体 | Supabase Storage のみ（バケット定義は復元されるが中身は無い） | 小〜中（再アップロードで可な内容か次第） |

**Supabase の無料プランには自動バックアップが無い**（Pro以上のみ）。公式ドキュメントでも
無料プランは `db dump` で自分でエクスポートしオフサイト保管することが推奨されている。
また **プロジェクトを削除すると、Supabase 側のバックアップも含めて完全に消える**。

---

## 2. 毎日のバックアップ（自動）

`.github/workflows/backup.yml` が毎日 JST 03:00 に実行され、
プライベートリポジトリ `<owner>/<app>-backups` に以下をコミットする。

| ファイル | 内容 |
|---|---|
| `schema.sql` | テーブル・RLSポリシー・関数・トリガ・権限（**再構築の土台**） |
| `data.sql` | 業務データ（public スキーマ） |
| `auth_data.sql` | 認証ユーザー（`auth.users` / `auth.identities`） |

取得には **`pg_dump` を直接**使う（Supabase CLI は使わない）。CLI は `pg_dump` を
コンテナ内で実行する際に接続URLを解析し直すため、**Session pooler 用のユーザー名
`postgres.<project-ref>` が `postgres` に落ちて認証に失敗する**。

- **世代管理は Git の履歴そのもの。** 「3日前の状態」は `git show HEAD~3:data.sql` で取り出せる。
  保存期間の上限が無いため、法定保存年数などの要件にも対応できる。
- 内容に変更が無い日はコミットされない。実行の記録は GitHub の Actions のログに残る。
- **副次効果**: 毎日実DB接続することで、Supabase 無料プランの「7日間アクセスが無いと一時停止」も
  同時に回避できる（専用の keep-alive pingは不要になる）。
- **失敗すると GitHub からオーナー宛にメールが届く。** 届いたら放置しないこと。

### バックアップ用トークンの再発行（有効期限が来たら）

`BACKUP_REPO_TOKEN` には有効期限がある（既定1年）。**切れるとバックアップが静かに止まる**。

1. https://github.com/settings/personal-access-tokens で古いトークンを開く
   - **「Regenerate token」**があればそれが最短（権限設定を引き継げる）
2. 新規作成の場合: Repository access は対象の backups リポジトリのみ、
   Permissions → Contents: Read and write
3. `<owner>/<app>` の Settings > Secrets and variables > Actions で
   `BACKUP_REPO_TOKEN` を更新
4. Actions から手動実行し、成功すること・警告が消えることを確認

### 必要な Secrets

| 名前 | 値 |
|---|---|
| `SUPABASE_DB_PASSWORD` | Supabase のDBパスワード（そのまま。URLエンコード不要） |
| `BACKUP_REPO_TOKEN` | バックアップ先リポジトリへ push できる Personal Access Token |

> ⚠️ **Session pooler のユーザー名は `postgres.<project-ref>`。**
> ただし **`password authentication failed for user "postgres"` というエラーからは原因を判別できない。**
> Session pooler はプロジェクトを識別したあと内部では `postgres` として認証するため、
> ユーザー名を正しく送っていても文言は常に `user "postgres"` になる。
> このエラーが出たら、パスワード・ユーザー名・**接続URLを解析し直すツール（Supabase CLI）**の
> いずれかを疑うこと。ワークフローには接続テストのステップがあるので、
> そこで通るかどうかで資格情報の問題かダンプ側の問題かを切り分けられる。
> また **直結（`db.<ref>.supabase.co`）は使えない**（GitHub Actions は IPv4 で、Supabase の
> 直結は IPv4 だと有料アドオンが必要）。**Transaction pooler（6543）では `pg_dump` が動かない**ため、
> 必ず **5432 の Session pooler** を使う。

---

## 3. データを復元する

```bash
git clone https://github.com/<owner>/<app>-backups.git
cd <app>-backups
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

- ユーザーがログインできる（`auth.users` が入っているか）
- 主要な画面でデータが正しく表示される
- アプリ固有の設定値（`app_settings` 相当のテーブル）が入っているか

---

## 4. Supabase を作り直す場合の設定（Git に無い）

新しいプロジェクトを作ったら、以下を**手作業で**再設定する。

1. **Authentication > URL Configuration**: Site URL / Redirect URLs を本番URLに合わせる
2. **Authentication > Emails**: カスタムのメールテンプレートを使っていれば再設定
   （PKCE/token_hash 周りの注意は `supabase-invite-auth` スキル参照）
3. **Authentication > SMTP Settings**: カスタム SMTP を使っていれば再設定
4. **Storage**: バケット定義は `schema.sql` に含まれるが、**中のファイルは含まれない**。
   必要なファイルは別途バックアップするか、再アップロードする
5. 新しい URL・キーをホスティング側（環境変数）に反映する

---

## 5. ホスティングを作り直す場合の設定（Git に無い）

1. リポジトリを再接続し、ビルド/デプロイコマンドを再設定
2. Secrets（暗号化された環境変数）を再登録
3. 公開URL・カスタムドメインの設定を再確認
4. デプロイ後、**Supabase の Site URL / Redirect URLs を新しいURLに合わせる**（§4-1）

---

## 6. パスワードマネージャに保管しておくもの

以下は**どこにも自動保存されていない**。人が保管する必要がある。

- Supabase の **DBパスワード**
- Supabase の **service role key**（未使用でも復旧作業で必要になりうる）
- アプリが使う外部サービスのパスワード/APIキー（SMTPアプリパスワード等）
- GitHub の **Personal Access Token**（バックアップ用。再発行も可能）
- Supabase / ホスティング / GitHub の各アカウント情報

---

## 7. 定期的に確認すること

- [ ] **年1回**、バックアップから実際に復元できるか試す（無料プロジェクトをもう1つ作って流し込む）。
      **試していないバックアップは、あると思い込んでいるだけで存在しないのと同じ。**
- [ ] **年1回**、ホスティング側も別アカウントで実際にデプロイできるか試す
- [ ] バックアップの Actions が失敗していないか（失敗時はメールが届く）
- [ ] トークンの期限が近くないか
- [ ] Supabase の無料プロジェクトは **7日間アクセスが無いと一時停止**する
      （毎日のバックアップが実DB接続を発生させるので、通常は自動的に回避される）

---

## 8. 既知の課題（このアプリ固有。テンプレートからは削除してよい）

- `supabase/migrations/` がスキーマの完全な履歴になっているか確認する。
  ダッシュボードから直接適用した変更は記録に残らないことがある。
  再構築には必ず**バックアップの `schema.sql`**を使うこと（マイグレーションを順に流しても
  現在のスキーマを再現できるとは限らない）。
