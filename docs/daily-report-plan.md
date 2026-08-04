# 日報機能 統合開発計画

作成: 2026-08-04
対象: 現行 FileMaker アプリ `koizumi-report`（オンプレ FileMaker Server 稼働）の
タスク管理システム（Cloudflare Workers）への統合

> 本書は計画段階の文書。実装確定時は設計書 `task-management-spec-cloudflare.md` へ反映する。

---

## 1. 方針

### 1-1. 統合の形

**既存の Worker・SPA にセクションを追加する形で統合する**（別アプリにしない）。理由:

- 認証（bcrypt + HS256 JWT・token_version 失効）、セキュリティヘッダ／CSP、PWA 更新検知、
  Supabase service role 経由のデータアクセスといった基盤をそのまま流用できる
- 無料枠の観点でも Worker を増やさないほうが有利（リクエスト数は合算だが管理が単純）
- 「タスクの実績をそのまま日報へ転記」という要件が、同一システム内なら API を跨がずに実現できる

### 1-2. 画面の切り替え

現行 FileMaker のヘッダにも「タスク管理 / BKB管理」のセグメント切替があり、利用者に馴染みがある。
これを踏襲し、**共通ヘッダ（`AppHeader.jsx`）にセグメント切替を置く**。

```
[栄和ロゴ] 栄和 タスク管理システム   [ タスク ｜ 日報 ]        ○○さん  ☰
```

- ハンバーガーメニューの項目は、選択中のセクションに応じて出し分ける
  （タスク側: メイン/アーカイブ/設定/従量課金/処理ログ、日報側: 日報一覧/不正駐車一覧/自主検査表/定型文設定）
- モバイルではセグメントをヘッダ2段目に折り返す

### 1-3. UI/UX の方針

現行の踏襲にはこだわらず、**「終業前の数分で入力が終わる」**ことを最優先にする。

| 現行の入力 | 新システムでの狙い |
|---|---|
| 特記事項を時刻＋本文で1行ずつ入力 | 「＋追加」で行が増え、時刻は**現在時刻を既定値**に。定型文はサジェスト候補から1タップ |
| 写真は FileMaker に右クリックで挿入 | スマホの**カメラを直接起動**して撮影 → 自動リサイズ → その場でコメント入力 |
| 自主検査表は紙に手書き | **「すべて良好」1タップ**で全項目○。不備のある項目だけタップして×に落とす（現行の記入ルールと同じ） |
| 不正駐車はナンバーを手入力 | 車両写真を撮影 → ナンバー等を入力。**同じナンバーの過去履歴と累計回数を自動表示** |

---

## 2. 現行機能の移行マッピング

| 現行（FileMaker） | 移行先 | 備考 |
|---|---|---|
| 報告書一覧 | 日報一覧画面 | 日付・担当者・作業記録の抜粋・写真枚数 |
| 詳細「基本情報」タブ | 日報詳細（作業記録） | 作業者AM/PM、作業日時、時刻＋内容の明細 |
| 詳細「個別写真」タブ | 日報詳細（写真） | 写真＋コメント＋撮影日時 |
| 詳細「不正駐車記録」タブ | 日報詳細（不正駐車） | 写真・ナンバー・車種・所有会社・違反事項 |
| 不正駐車一覧（日付順/ランキング） | 不正駐車一覧画面 | 検索・統計・累計回数 |
| 詳細「残留塩素濃度」タブ | 日報詳細（残留塩素） | 週1回・建物別・濃度＋4項目のOK/NG |
| 「特記事項設定」 | 定型文マスタ設定 | ルーチン業務の文言 |
| 基本情報タブ右「本日予定のビルメンテと実績」 | **カレンダー連携で代替** | 既にタスク管理が Google カレンダーから当日イベントを取得済み |
| 基本情報タブ右「蛍光灯ランプの交換実績」 | FileMaker 連携（Phase 6） | 別アプリのデータ。優先度は低い |
| 紙の「自主検査表（日常）」 | 自主検査表画面（新規） | 手書きからの移行。日次入力 |
| 「備品入出庫」タブ | **要確認**（画面未提供） | 中身を確認のうえ要否を判断 |
| 「会議室の電灯 ON/OFF」 | **要確認** | 現行ヘッダにある機能。移行対象か確認したい |

---

## 3. データモデル（Supabase / PostgreSQL）

既存の `tasks` 等とは独立したテーブル群として追加する。すべて service role 経由（anon 不可）で、
既存の権限方針（設計書8章）を踏襲する。

### daily_reports（日報ヘッダ・1日1件）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| report_date | date unique | 日付。現行と同じく1日1件 |
| site | text | 現場（既定「備後町コイズミビル」）。将来の複数現場に備える |
| worker_am / worker_pm | text | 作業者（岡田・西川・橋口・その他） |
| work_start / work_end | time | 作業日時（既定 9:00〜18:00） |
| created_by | uuid | users 参照 |
| created_at / updated_at | timestamptz | |

### report_entries（作業記録の明細）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| report_id | uuid | daily_reports 参照（on delete cascade） |
| entry_time | time | 時刻 |
| content | text | 内容（フリー入力 or 定型文から選択） |
| source_task_id | uuid | **タスク管理から転記した場合の元タスク**（null 可） |
| sort_order | int | 並び順 |

### report_photos（写真・動画）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| report_id | uuid | daily_reports 参照 |
| category | text | `work`（作業エビデンス）/ `parking`（不正駐車）/ `chlorine` |
| parking_id | uuid | 不正駐車レコード参照（category='parking' のとき） |
| storage_key | text | R2 のオブジェクトキー |
| filename / mime / size | text/text/int | |
| width / height | int | 表示レイアウト用 |
| comment | text | 写真ごとのコメント |
| taken_at | timestamptz | 撮影日時（EXIF、無ければアップロード時刻） |

### parking_violations（不正駐車）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| report_id | uuid | daily_reports 参照 |
| checked_at | timestamptz | チェック時刻 |
| plate_region / plate_number | text | プレート地名・番号。**この2列で過去履歴を名寄せ** |
| maker / model | text | メーカー・車種 |
| owner_company | text | 所有会社/訪問先 |
| violations | text[] | `unrecorded`/`false_entry`/`long_stay`/`after_hours`/`other` |
| note | text | 補足 |

> 累計回数（現行の「トータル30回」）は `plate_region + plate_number` の COUNT で算出する。
> 索引 `(plate_region, plate_number)` を張る。

### chlorine_tests（残留塩素・週1回）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| report_id | uuid | daily_reports 参照 |
| building | text | `BKB` / `小泉本社` |
| location | text | 採水場所（1F給湯室 等） |
| tested_at | timestamptz | |
| concentration | numeric(3,2) | 濃度（0.10 等） |
| color_ok / turbidity_ok / odor_ok / taste_ok | boolean | 色・濁り・臭気・味 |
| inspector | text | 検査者 |

> 写真の保管は必須ではない（ご要望どおり）。撮る場合は report_photos に `category='chlorine'` で紐付ける。

### fire_inspections（自主検査表・日次）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| building | text | ビル名（BKB 等） |
| inspected_on | date | 実施日。`(building, inspected_on)` で unique |
| inspector | text | 点検者名 |
| all_clear | boolean | 「点検箇所一斉」○ に相当 |
| items | jsonb | 項目ごとの判定 `{"防火区画":"ok","避難通路":"ng",…}`（○良/×不良/◎即時改修） |
| note | text | 不備の内容 |
| periodic_result | text | 6月・12月の定期点検結果（`ok`/`ng`、該当月のみ） |
| confirmed_by | text | 防火管理者確認 |

> 検査項目は紙の様式に合わせて15項目（点検箇所一斉／防火区画／避難通路×2／通路非常照明／
> 階段・防火戸／階段非常照明／非常用進入口／カーテンじゅうたん等／喫煙場所×2／フード・ダクト／
> ガス設備・器具／危険物等／消防用設備）。項目定義はコード側の定数で持ち、`items` に判定のみ保存する。

### routine_templates（定型文マスタ）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| label | text | 定型文の本文 |
| sort_order | int | |
| is_active | boolean | |

### maintenance_results（メンテナンス予定の実績）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| report_id | uuid | daily_reports 参照 |
| task_id | uuid | **カレンダー由来タスク**（`tasks.source='calendar'`）への参照 |
| scheduled_start / scheduled_end | timestamptz | 予定 |
| actual_start / actual_end | timestamptz | 実績 |
| cancelled | boolean | 中止 |
| result_note | text | 実施結果の報告事項 |

---

## 4. 写真ストレージ設計

### 4-1. 容量試算

現行の実績（一覧画面の写真枚数、詳細画面のファイルサイズ実測 543〜788KB）から試算した。

| 項目 | 値 |
|---|---|
| 作業写真 | 平均 1.12 枚/日 × 250営業日 ≒ 281 枚/年 |
| 不正駐車 | 年20件 × 2枚 ≒ 40 枚/年 |
| 合計 | **約 321 枚/年** |

| 保存方式 | 年間容量 |
|---|---|
| 原本のまま（現行相当） | 約 204 MB/年 |
| **長辺1600px / JPEG q0.8（推奨）** | **約 78 MB/年** |
| 長辺1280px / JPEG q0.75 | 約 47 MB/年 |

動画（mov）を含める場合は年10本×30MB ≒ 300MB/年 と、写真の約4倍を占める。

### 4-2. 保管先の比較

| 保管先 | 無料枠 | 持ち年数(※) | 評価 |
|---|---|---|---|
| **Cloudflare R2（推奨）** | 10 GB | 約 27 年 | egress 無料。Worker から直接バインドでき、認証も既存の JWT で完結 |
| Supabase Storage | 1 GB | 約 2.7 年 | 既存サービス内で完結するが、動画を含めると数年で逼迫する |

※ 写真78MB + 動画300MB = 約375MB/年 として算出

**結論: Cloudflare R2 を推奨。** ただし R2 の有効化にはアカウントへのクレジットカード登録が必要な場合が
あるため、事前確認が必要（無料枠内であれば課金は発生しない）。R2 が使えない場合は Supabase Storage を
使い、動画は対象外とする案に切り替える。

### 4-3. 削減の工夫

1. **クライアント側でリサイズしてから送る** — ブラウザの Canvas API で長辺1600pxへ縮小し JPEG 再エンコード。
   通信量も削減でき、モバイル回線でも軽い（原本の約 1/3）
2. **サムネイルを別生成** — 一覧表示用に長辺320pxの縮小版を併せて保存（1枚あたり +20KB 程度）。
   一覧で原本を読み込まないため表示が速く、R2 の読み取り回数も抑えられる
3. **動画は上限を設ける** — 1本あたりの上限（例: 50MB）と、必要に応じて保管期間を設定する

### 4-4. 配信方式

既存の添付ファイル機能と同じ考え方を使う。

- アップロード: `POST /api/report/photos`（JWT必須）→ Worker が R2 へ put
- 表示: `GET /api/report/photo?id=…`（JWT必須）→ Worker が R2 から取得して返す。
  フロントは Bearer 付き fetch → Blob URL（既存 `fetchAttachmentBlob` と同じ方式）
- 画像は Blob URL で Safari を含め問題なく表示できることが検証済み
  （プロジェクトスキル `.claude/skills/multi-env-attachment-preview/` 参照）

---

## 5. 権限設計（オーナー閲覧）

`users` にロールを追加する。

| ロール | 権限 |
|---|---|
| `staff`（既定） | 現行どおり全機能 |
| `owner` | **日報の閲覧のみ**。タスク管理・設定・従量課金は不可 |
| `admin` | staff に加えて設定変更（将来の分離用。当面は staff と同等） |

- `users.role text not null default 'staff'` を追加し、ログイン時に発行する JWT へ `role` を埋め込む
- Worker 側で、タスク管理系 API は `staff`/`admin` のみ、日報系 API は全ロール（`owner` は GET のみ）に制限
- フロントは `role` に応じてヘッダのセグメント自体を出し分ける（owner には日報のみ表示）
- 既存の `token_version` による即時失効はそのまま機能する

> オーナーに見せる範囲（不正駐車・自主検査表を含めるか、写真を含めるか）は要確認。
> 既定案は「作業記録・写真・メンテナンス実績は閲覧可、不正駐車・自主検査表は非表示」とし、設定で切替可能にする。

---

## 6. 外部連携

### 6-1. Google カレンダー（メンテナンス予定）

**新規の連携は不要。** 既にタスク管理システムが当日イベントを取得してタスク化している
（設計書4-1章の 6.5）。日報側はそのタスクを参照して「本日の予定」を表示し、
実績（実施時刻・結果）を `maintenance_results` に記録する。

### 6-2. FileMaker 連携（蛍光灯ランプの交換実績）

| 方式 | 内容 | 評価 |
|---|---|---|
| **A. Push（推奨）** | FileMaker 側のスクリプトから `Insert from URL` で日報システムの API を叩く | FileMaker Server を外部公開せずに済む。安全 |
| B. Pull | Workers から FileMaker Data API を呼ぶ | FileMaker Server を HTTPS でインターネット公開する必要がある。Workers の送信元 IP は固定でないため IP 制限がかけられず、公開範囲を絞りにくい |

**方式Aを推奨。** ただし FileMaker 側の改修が必要なため、方式Bを採る場合はサーバーの外部到達性と
証明書の状況を確認したうえで、API キー方式の専用エンドポイントを用意する。

いずれも表示用の参照データであり、優先度は低い（Phase 6）。

---

## 7. 開発フェーズ

各フェーズは独立してリリースでき、**現行 FileMaker と並行運用しながら段階的に移行**する。

### Phase 1: 基盤 + 日報コア（最優先）
- `users.role` 追加、JWT への `role` 埋め込み、Worker 側の権限チェック
- 共通ヘッダにセグメント切替（タスク ｜ 日報）
- `daily_reports` / `report_entries` / `routine_templates`
- 日報一覧・日報詳細（作業記録の入力、定型文サジェスト、前日/翌日移動）
- **タスク管理からの転記**（タスク詳細に「日報へ転記」ボタン）
- → この時点で「毎日の作業記録」が新システムで完結する

### Phase 2: 写真
- R2 バインド、アップロード/取得 API、クライアント側リサイズ、サムネイル生成
- カメラ直接起動（`<input type="file" accept="image/*" capture="environment">`）
- 写真＋コメントの表示・並べ替え・削除

### Phase 3: 自主検査表（手書きからの移行）
- `fire_inspections`
- モバイル最適化した入力画面（「すべて良好」1タップ → 不備項目のみ×）
- 月次の一覧表示（紙の様式に近い形）と印刷用レイアウト

### Phase 4: 不正駐車
- `parking_violations`、記録 UI（写真撮影 → ナンバー入力）
- **入力時に同一ナンバーの過去履歴・累計回数を自動表示**
- 一覧画面（検索・日付順/ランキング切替・統計）
- **過去データの移行**（累計回数の連続性のため実質必須。FileMaker から CSV/JSON で書き出し→インポート）

### Phase 5: 残留塩素 + メンテナンス実績
- `chlorine_tests`（週1回・建物別）
- `maintenance_results`（カレンダー由来タスクと紐付け、予定通り/本日実施/中止）

### Phase 6: 公開・連携
- オーナー（小泉産業様）アカウントの発行と閲覧範囲の設定
- FileMaker 連携（蛍光灯ランプの交換実績）
- 現行 FileMaker アプリの停止判断

---

## 8. 要確認事項

計画を確定するために伺いたい点。**1〜3は設計の骨格に関わるため、着手前に確認したい。**

1. **Cloudflare R2 の有効化可否** — アカウントにクレジットカード登録が必要な場合がある
   （無料枠内なら課金なし）。不可なら Supabase Storage 案（動画は対象外）に切り替える
2. **建物の関係** — 「BKB」「小泉本社」「備後町コイズミビル」の関係。日報は1日1件でよいか、
   建物ごとに分けるか（残留塩素と自主検査表は建物別に見えるため）
3. **オーナーに見せる範囲** — 不正駐車・自主検査表・写真を含めるか
4. **過去データの移行範囲** — 不正駐車は累計回数の連続性のため移行を推奨。作業記録・写真はどうするか
   （移行しない場合は現行 FileMaker を参照用に残す）
5. **動画（mov）の扱い** — 容量が写真の約4倍。上限サイズ・保管期間を設けるか
6. **「備品入出庫」タブ** — 画面が未提供のため中身と移行要否を確認したい
7. **「会議室の電灯 ON/OFF」** — 現行ヘッダにある機能。移行対象か
8. **FileMaker Server の外部到達性** — 方式B（Pull）を採る場合のみ必要
