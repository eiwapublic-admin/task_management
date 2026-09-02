# Google OAuth スコープ拡張 手順書（リフレッシュトークンの再発行）

最終更新: 2026-09-02（ビルメンテナンス管理機能（`docs/bilmen-plan.md`）の 13-1 への対応として作成）

---

## 0. この手順書の目的

ビルメン機能の **Google カレンダー自動登録**と**案内メールの下書き作成**を有効にするため、
`GMAIL_REFRESH_TOKEN` を**書き込みスコープを含めて再発行**します。

現在のトークンは**読み取り専用**（`gmail.readonly` ＋ `calendar.readonly`）のため、
カレンダーへの書き込みもメール下書きの作成もできません。

> **同じ作業を過去に1回実施しています**（2026年、カレンダー連携の開通時。`docs/HANDOFF.md`
> 「Google カレンダー連携（開通済み）」参照）。そのときと**まったく同じ手順**で、
> 選ぶスコープが増えるだけです。

**所要時間の目安: 15〜20分**（うちデプロイ待ちが数分）

---

## URL 一覧（作業で開くページ）

使う順に並べています。**Google 側の操作は `eiwa.public@gmail.com` でログインした状態で行ってください。**

| # | 用途 | URL |
|---|---|---|
| 1 | **OAuth 同意画面**（「本番環境」か確認。1章 #1） | https://console.cloud.google.com/apis/credentials/consent |
| 2 | **有効なAPI**（Gmail API・Google Calendar API の確認。1章 #2・#3） | https://console.cloud.google.com/apis/dashboard |
| 3 | **認証情報**（クライアントID／シークレットの確認、リダイレクトURIの追加・削除。手順1・手順7） | https://console.cloud.google.com/apis/credentials |
| 4 | **OAuth Playground**（認可とトークン取得。手順2〜4） | https://developers.google.com/oauthplayground/ |
| 5 | **GitHub Secrets**（`GMAIL_REFRESH_TOKEN` の更新。手順5） | https://github.com/eiwapublic-admin/task_management/settings/secrets/actions |
| 6 | **GitHub Actions**（デプロイの実行と結果確認。手順6） | https://github.com/eiwapublic-admin/task_management/actions |
| 7 | **操作ログ画面**（動作確認。手順6） | https://task-management.eiwa-public.workers.dev/logs |

**手順1でクライアントに追加するリダイレクト URI**（この文字列そのものを登録します。末尾スラッシュなし）:

```
https://developers.google.com/oauthplayground
```

> Google Cloud Console で**複数のプロジェクトがある場合**は、画面上部のプロジェクト選択で
> このシステム用のプロジェクト（Gmail/Calendar API を有効にしてあるもの）に切り替えてから
> 上記URLの各ページを開いてください。プロジェクトを取り違えると、目的のクライアントIDが
> 一覧に出てきません。

---

## 1. 作業の前に（前提の確認）

以下はすべて**既に満たされているはず**ですが、念のため確認してください。

| # | 確認すること | 確認場所 | 期待する状態 |
|---|---|---|---|
| 1 | OAuth アプリが**「本番」公開**されている | Google Cloud Console →「APIとサービス」→「OAuth 同意画面」 | 公開ステータス＝**本番環境**<br>（「テスト」だと**リフレッシュトークンが7日で失効**します） |
| 2 | **Gmail API** が有効 | 「APIとサービス」→「有効なAPI とサービス」 | 一覧にある |
| 3 | **Google Calendar API** が有効 | 同上 | 一覧にある（Gmail とは別に有効化が必要） |
| 4 | OAuth クライアントの **Client ID / Client Secret** が手元にある | 「APIとサービス」→「認証情報」→ OAuth 2.0 クライアント ID | GitHub Secrets の `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` と同じもの |

> **重要**: クライアントは**今使っているものをそのまま使ってください**。別のクライアントで
> 取り直すと `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` も差し替えが必要になります。

**作業中は Google アカウント `eiwa.public@gmail.com` でログインしてください。**
別アカウントで認可すると、そのアカウントのメール・カレンダーに対するトークンになってしまいます。

---

## 2. 今回要求するスコープ（4つ）

認可画面で次の**4つすべて**を指定します。**現在使っている2つを必ず含めてください**
（含め忘れると既存のメール自動取得・カレンダー参照が止まります）。

```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.compose
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/calendar.events
```

| スコープ | 用途 | 状態 |
|---|---|---|
| `gmail.readonly` | メールの自動取得（既存のパイプライン） | **現行・必ず含める** |
| `gmail.compose` | 案内メールの**下書き作成**（ビルメン。将来の直接送信も含む） | **今回追加** |
| `calendar.readonly` | カレンダー一覧・当日イベントの取得（既存のタスク化機能） | **現行・必ず含める** |
| `calendar.events` | 予定の**作成・更新・削除**（ビルメン） | **今回追加** |

> **`calendar.readonly` を外さない理由**: 既存機能は購読カレンダー一覧（`calendarList`）を
> 読んでいます。`calendar.events` はイベントの読み書き用スコープで、カレンダー一覧の
> 取得までカバーするか確実でないため、**両方を要求して既存機能を確実に保ちます**。
> 既に持っているスコープを重ねて要求しても不利益はありません。

> **`gmail.send` ではなく `gmail.compose` を使う理由**: `gmail.compose` は下書き作成と送信の
> 両方を含みます。将来「下書き」から「直接送信」へ運用を変える際に、**再度この作業をしなくて済みます**。

---

## 3. 手順

### 手順1. OAuth Playground をリダイレクト先として一時的に許可する

1. Google Cloud Console →「APIとサービス」→「**認証情報**」
2. 使用中の **OAuth 2.0 クライアント ID** をクリック
3. 「**承認済みのリダイレクト URI**」に次を**追加**して保存

   ```
   https://developers.google.com/oauthplayground
   ```

> この設定は**作業後に削除します**（手順7）。
> クライアント種別が「デスクトップ アプリ」の場合はリダイレクト URI 欄がありません。
> その場合はこの手順を飛ばして手順2へ進んでください（Playground 側でエラーになったら、
> 「ウェブ アプリケーション」型のクライアントを使う必要があります）。

### 手順2. OAuth Playground を開き、自社クライアントを使う設定にする

1. https://developers.google.com/oauthplayground/ を開く
2. 右上の**歯車アイコン（⚙ OAuth 2.0 Configuration）**をクリック
3. 次のように設定する

   | 項目 | 設定値 |
   |---|---|
   | **Use your own OAuth credentials** | ✅ チェックを入れる |
   | OAuth Client ID | `GMAIL_CLIENT_ID` の値を貼り付け |
   | OAuth Client secret | `GMAIL_CLIENT_SECRET` の値を貼り付け |
   | **Access type** | **Offline**（← リフレッシュトークンを得るために必須） |
   | **Force prompt consent screen** | ✅ チェックを入れる（← 必須。下記参照） |

> **「Force prompt consent」に必ずチェックを入れてください。** Google は既に同意済みの
> アカウントに対して**リフレッシュトークンを再発行しません**。強制的に同意画面を出すことで
> 新しいリフレッシュトークンが発行されます。ここを忘れると手順4で
> 「Refresh token」欄が空のまま出てきます。

### 手順3. スコープを入力して認可する

1. 画面左「**Step 1: Select & authorize APIs**」の一番下にある
   「**Input your own scopes**」欄に、2章の4つのスコープを**半角スペース区切りの1行**で貼り付ける

   ```
   https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events
   ```

2. 「**Authorize APIs**」をクリック
3. Google のログイン画面で **`eiwa.public@gmail.com`** を選ぶ
4. 「**このアプリは Google で確認されていません**」と出た場合
   → 「詳細」→「（安全でないページ）に移動」で続行してよい（自社アプリのため。`HANDOFF.md` 参照）
5. 権限の確認画面で、**4つの権限がすべて表示されていること**を確認してから「続行 / 許可」

   実際に表示される日本語の文言と、対応するスコープは次のとおり:

   | 同意画面の表示 | スコープ |
   |---|---|
   | メール メッセージと設定の表示 | `gmail.readonly` |
   | 下書きの管理とメールの送信 | `gmail.compose` |
   | すべてのカレンダーの予定の表示と編集 | `calendar.events` |
   | Google カレンダーを使用してアクセスできるすべてのカレンダーの参照、ダウンロード | `calendar.readonly` |

### ⚠ 手順3.5【必ず確認】自社クライアントが使われているか

**認可後、画面右の「Request / Response」欄に出る `client_id=` を必ず見てください。**

| 表示 | 判定 |
|---|---|
| `client_id=407408718192.apps.googleusercontent.com` | ❌ **NG**。これは **OAuth Playground の共有クライアントID**。手順2の設定が効いていない |
| `client_id=`（`GMAIL_CLIENT_ID` と同じ値） | ✅ OK。次へ進む |

**NG のまま進めると、発行されるトークンは Playground のクライアントに紐づくため、
Worker が `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` で更新しようとして弾かれます**
（`invalid_grant`）。さらに Playground のトークンは**24時間で自動失効**します。
画面下部に出る次の注記が、その状態であることのサインです:

> *Note: The OAuth Playground will automatically revoke refresh tokens after 24h.
> You can avoid this by specifying your own application OAuth credentials using the Configuration panel.*

**NG だった場合の直し方**: 歯車 ⚙ →「Use your own OAuth credentials」にチェック →
Client ID / Client secret を入力 → パネルを閉じ、**手順3（Authorize APIs）からやり直す**。

> このとき初めて**手順1のリダイレクトURI登録が実際に必要**になります（Playground の共有
> クライアントには登録済みだが、自社クライアントには登録が要る）。未登録だと
> `redirect_uri_mismatch` が出るので、認証情報ページで追加してください。

### 手順4. リフレッシュトークンを取得する

1. 「**Step 2: Exchange authorization code for tokens**」の
   「**Exchange authorization code for tokens**」をクリック
2. **`Refresh token`** の欄に **`1//` で始まる長い文字列**が表示される
3. これを**そのままコピー**する（前後に空白・改行が入らないよう注意）

> `Refresh token` が**空**だった場合は、手順2の「Force prompt consent screen」の
> チェックが入っていません。チェックして手順3からやり直してください。

### 手順5. シークレットを差し替える

**旧トークンは手順6の確認が終わるまで捨てずに控えておいてください**（切り戻し用）。

GitHub Secrets から更新します（デプロイ時に Worker へ自動同期されます）。

1. GitHub リポジトリ `eiwapublic-admin/task_management` →
   「Settings」→「Secrets and variables」→「Actions」
2. **`GMAIL_REFRESH_TOKEN`** の「Update」をクリックし、手順4の値に置き換えて保存

### 手順6. デプロイして動作確認する（ここが最重要）

1. 「Actions」タブ →「**Deploy to Cloudflare Workers**」→「Run workflow」で手動実行
   （または main への push で自動実行される）
2. 完了後、**5〜10分待って**アプリの「**操作ログ**」画面（`/logs`）を開く
3. 次の2点を確認する

   | 確認項目 | 期待する結果 |
   |---|---|
   | **メール取得** | 「メール取得」のログが**エラーなく**記録されている |
   | **カレンダー取得** | 「利用可能なカレンダー: …」や権限エラーが**出ていない** |

> **`invalid_grant` や「Insufficient Permission」が出た場合は手順8（切り戻し）へ。**

### 手順7. 後始末

動作確認が取れたら、手順1で追加したリダイレクト URI
`https://developers.google.com/oauthplayground` を**削除**してください（不要な許可を残さないため）。

---

## 4. うまくいかないときは

| 症状 | 原因 | 対処 |
|---|---|---|
| Playground で `redirect_uri_mismatch` | 手順1のリダイレクト URI 追加が未反映 | URI が**完全一致**しているか確認（末尾スラッシュ無し）。保存後、反映に数分かかることがある |
| `Refresh token` が空 | 「Force prompt consent screen」未チェック | 手順2でチェックを入れて手順3からやり直す |
| デプロイ後に `invalid_grant` | トークンのコピーミス（空白混入）／アプリが「テスト」状態で失効 | トークンを貼り直す。OAuth 同意画面が「本番環境」か確認（1章の#1） |
| 「Insufficient Permission」 | スコープの指定漏れ | 手順3で**4つすべて**を入れたか確認して再取得 |
| メール取得が止まった | 新トークンに `gmail.readonly` が入っていない | 2章の4つで再取得。直らなければ手順8で切り戻す |

## 5. 切り戻し（動作確認に失敗した場合）

1. `GMAIL_REFRESH_TOKEN` を**旧トークンの値に戻す**
2. 再デプロイする
3. `/logs` でメール取得が復旧したことを確認する

旧トークンのスコープは読み取り専用なので、**メール取得・カレンダー参照は元どおり動きます**
（ビルメンのカレンダー登録・メール下書きだけが使えない状態に戻ります）。

---

## 6. この作業が終わったら

- ビルメン機能の **Phase 3（カレンダー自動登録）** と **Phase 4'（メール下書き・PDF自動添付）** に
  着手できるようになります（`docs/bilmen-plan.md` 12章）
- Phase 1・2・4（一覧・マスタ・掲示PDF・`mailto:` でのメール作成）は**この作業を待たずに**進められます
- 完了後、`docs/HANDOFF.md` に実施記録を残してください
