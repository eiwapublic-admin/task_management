# 備品管理機能 開発計画（蛍光ランプの入出庫・設置記録）

最終更新: 2026-08-11（初版・計画のみ。実装は未着手）

対象: 現行 FileMaker アプリ **「備品管理」**（オンプレ FileMaker Server `eiwaserver.eiwa-up.com` 稼働）の
Web（Cloudflare Workers + Supabase）への移行。既存のタスク管理・日報と**同じアプリ内**に
第3のセクションとして統合する。

関連文書:
- [`task-management-spec-cloudflare.md`](./task-management-spec-cloudflare.md) … システム全体の設計書（実装後に4-15章として追記する）
- [`daily-report-plan.md`](./daily-report-plan.md) … 日報機能の計画。**移行の進め方・確定事項の考え方はこの文書に倣う**
- [`ui-standard.md`](./ui-standard.md) … **画面設計はこの標準に準拠する**（本計画の画面案もこの標準の部品名で書いている）
- [`HANDOFF.md`](./HANDOFF.md) … 運用・デプロイ手順

> 補足: 日報の計画（`daily-report-plan.md` 8章）では「備品入出庫は**保留**（現時点では移行対象外）」と
> していたが、2026-08-11 に**移行対象として着手**することになった。日報の Phase 6 に含まれていた
> 「FileMaker 連携（蛍光灯ランプの交換実績）」は、本機能で**双方向**（テナントマスタの取得／設置実績の提供）
> として実現するため、この計画に統合する。

---

## 1. 目的と範囲

### 目的

1. 蛍光ランプ（および電球・LED・電池）の**入庫と出庫（設置）を記録し、在庫を管理する**
2. **テナントへの設置**と**共用部への設置**を区分して記録する
3. テナント設置時は、**iPad / スマホに手書き署名**をもらい、受領の証跡として保存する
   （その場でもらうのが基本だが、**先に記録だけ入力して後日署名だけもらう**運用もあるため、
   システム上は必須にしない。2026-08-11 確定。5-5 参照）
4. テナントマスタは FileMaker Server 上の**検針記録データベースを正**とし、Web 側は同期して使う
5. FileMaker 側のアプリから、**テナントに設置したランプ実績を年月指定で WebAPI 取得**できるようにする

### 今回の範囲に含むもの

| 現行 FileMaker の画面 | 移行方針 |
|---|---|
| 入出庫記録（一覧・在庫表示） | 移行する。**モバイル前提に作り直す**（後述 5-1） |
| 入庫登録 | 移行する（5-2） |
| 出庫・設置記録（テナント／共用部） | 移行する。署名込み（5-3・5-4） |
| 備品情報（備品マスタ） | 移行する（5-5） |
| カテゴリマスタ | 移行する。件数が少ないため備品マスタ画面内のモーダルで扱う（5-5） |
| テナントマスタ | **参照専用**として移行。FileMaker から同期し、当システムで持つのは「デフォルト備品」だけ（5-6・7-1） |

### 今回の範囲に**含めない**もの（合意が要る／優先度が低い）

- **各種出力**（現行ヘッダの「各種出力」ボタン）… どの帳票が要るか未確認。要件が出てから別途
- **修理伝票**（出庫画面のボタン）… 別業務。現行の使われ方が不明
- **ログオン**（現行の独自ログオン）… 当システムの既存ログイン（JWT）に統一する
- 発注機能（在庫警告は出すが、発注そのものは行わない）

---

## 2. 現行 FileMaker アプリの分析（画面ショットから）

移行の元になる情報。**ここが実際の運用と食い違っていないかの確認を最初にお願いしたい**（12章）。

### 2-1. 入出庫記録（メイン画面）

- ヘッダ: `入出庫 / 備品 / カテゴリ / テナント / 各種出力 / ログオン`、`3ヶ月前から表示する`、`修正ロック`、
  右上に `入庫` `出庫` ボタン、注記「**＊在庫調整は「入庫」から**」
- 備品ごとの見出し帯: 備品名（FLR40SW）・製品番号（FLR40SW/M/36）・**在庫数（44）**・入庫/出庫ボタン。
  在庫が警告数量以下だと**赤地**になり「**発注依頼してください。**」が出る
- 年ごとの小見出し: **年計（入庫 52 / 出庫 8）**
- 明細行: `入出庫日付 / 備品 / 入庫 / 出庫 / 在庫（その行時点の残高） / 階 / 設置先 / 署名（サムネイル） / 担当`
  - 入庫は緑字、出庫は青字。**在庫調整は入庫にマイナス値**（例: `-2`）で記録されている
  - 在庫がマイナスの行も存在する（`-2`）＝ **在庫のマイナスは禁止されていない**
  - 設置先は `喫煙室(1F)` `通路(1F)` `備後町富士法律経済研究所(7F)` のように**共用部の場所名とテナント名が同じ列**に出る
  - 担当は `信国` `廣畑・岡田` `西川` のように**1レコードに複数名が入ることがある**（自由入力欄）

### 2-2. 入庫登録

`入出庫区分=入庫` / 入庫日付 / 入庫時刻 / **入庫理由（調達・繰延登録・在庫調整）** / 備品ID（ドロップダウン） /
調達先 / 入庫数量 / **入庫前在庫数・入庫後在庫（自動計算の表示）** / 担当者 / 備考（在庫調整理由など）

### 2-3. 出庫・設置記録

`入出庫区分=出庫` / 入出庫日付 / 入出庫時刻 / **入出庫理由（テナント設置・共用部設置・新規入替・不良品処分）**

- **テナント設置**: `設置先テナント`（ドロップダウン＋右に補足欄） / 備品ID / 出庫数量 / **在庫数 44 → 44** /
  担当者（「担当者を選択」） / **受領サイン**（枠・「iPadで入力可」）＋`受領サイン`ボタン＋`取消`ボタン /
  **受領タイムスタンプ** / 備考 / 修正者・修正情報タイムスタンプ
- **共用部設置**: テナント欄の代わりに `設置階`（階のドロップダウン）＋`設置場所`（「設置場所を選択」）

画面下部に**一般ユーザの制約**が明記されている（＝そのまま権限仕様として移行する。9章）:

> ・出庫の場合、受領サインが入力されるとデータの修正ができません。
> ・入庫の入力はできますが、後から修正することはできません。
> ・前日以前に入力した入出庫は削除できません。

### 2-4. 備品情報（備品マスタ）

カテゴリごとにグルーピングして表示。列は
`備品ID / 表示順 / 備品名 / 製品番号（発注用情報） / 警告数量 / 無効 / 在庫数`。右上に「備品追加」。

- 備品ID は 2, 3, 5, 42, 47, 51, 52, 53 … と**連番でない整数**（＝FileMaker の既存 ID。移行の突合キーになる）
- 表示順は 11, 12, 13, 14, 99 … （99＝末尾）
- `無効` にチェックが付いた備品（FL20SSW）は在庫数欄がグレーアウト
- 「**予備40型（在庫管理外）**」という備品があり、在庫が黄色の `-2`。**在庫管理の対象外**という区分がある

### 2-5. カテゴリマスタ

`カテゴリコード / カテゴリ名称 / 備考` の3列・7件。
`A2 蛍光灯 20` `A4 蛍光灯 40` `A6 蛍光灯 丸型` `A9 その他蛍光灯` `B1 電球` `C1 LED` `D1 電池`

### 2-6. テナントマスタ

注記に「**※検針記録データベースを直接参照しています。ここでは「デフォルト備品」のみ設定します。**」とある。

列は `階 / 請求先コード / 正式名称 / 退去済み / A20_テナント備品関連::デフォルト備品ID / 検針に関する備考`。

- **共用部もテナントマスタに1行ある**（請求先コード `99990001` = `共用エリア`、階は空）
- 請求先コードは8桁（`73050011` など）。同一テナントで**光熱用と家賃で請求先コードが別**の例あり（三越伊勢丹）
- デフォルト備品ID は当システム側で持つ値（＝FileMaker 備品管理アプリ固有。検針記録DB側には無い）

---

## 3. 全体方針

### 3-1. 既存の作りに合わせる（新規性を持ち込まない）

日報機能を追加したときと**同じ形**で足す。これにより既存の運用・デプロイ手順・セキュリティ設計を
そのまま引き継げる。

| 層 | 方針 |
|---|---|
| フロント | `src/pages/Equipment*.jsx` を追加。**`docs/ui-standard.md` に準拠**（`.ui-page` → `.ui-container` → `.ui-toolbar`） |
| ヘッダ | `[ タスク ｜ 日報 ｜ 備品 ]` の3セグメントに拡張（`AppHeader.jsx`） |
| API | `worker/lib/equipment.js` を新設し、そこに閉じて実装する（`reports.js` と同じ流儀）。既存コードには手を入れない |
| DB | Supabase に新テーブル群。`anon`/`authenticated` への GRANT は**なし**（service role のみ）＝既存方針どおり |
| 認証 | 既存の JWT。書き込みは `canWrite()`（owner 不可）。加えて備品固有の修正ロック（9章） |
| 画像 | 署名画像は Supabase Storage。既存バケット `report-photos` に `equipment/signatures/` プレフィクスで置く |

### 3-2. 在庫数は「持たない」。入出庫の積み上げで算出する

在庫数を列として持つと、入出庫の修正・削除のたびに整合を取る必要があり、ズレたときに原因を追えない。
**入出庫レコードが唯一の正**とし、在庫はビューで集計する（4-2）。

- 現在庫 = Σ(入庫) − Σ(出庫)
- 明細行の「在庫」（その行時点の残高）は、**現在庫から新しい行の増減を順に引き戻して**算出する
  （日付降順に並べた一覧で、追加のクエリを増やさずに出せる）
- **在庫のマイナスは許容する**（現行がそうなっている）。保存時に警告は出すが、ブロックはしない

### 3-3. FileMaker とは当面「並行運用」する

日報のときと同じく、いきなり止めない。テナントマスタの同期（7-1）と設置実績の提供 API（7-2）が
入った時点で、現行 FileMaker アプリ側は**参照だけ**にできる状態を目指す。停止の判断は運用を見てから。

---

## 4. データモデル（Supabase）

`supabase/schema.sql` に追記し、同じ SQL をマイグレーションとして適用する（既存手順どおり）。

### 4-1. テーブル

```sql
-- ============================================================
-- 備品管理（2026-08-xx〜）。現行 FileMaker「備品管理」アプリの移行。
-- ============================================================

-- カテゴリマスタ（A2 蛍光灯 20 / A4 蛍光灯 40 / …）
create table if not exists equipment_categories (
  code       text primary key,                 -- A2 / A4 / A6 / A9 / B1 / C1 / D1
  name       text not null,
  sort_order int  not null default 99,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 備品マスタ
create table if not exists equipment_items (
  id            uuid primary key default gen_random_uuid(),
  -- FileMaker の「備品ID」（2, 3, 5, 42, 53…）。CSV移行・外部APIの突合キーなので必ず保持する
  item_no       int  not null unique,
  category_code text references equipment_categories(code),
  name          text not null,                 -- FLR40SW (白色)
  product_code  text,                          -- FLR40SW/M/36（発注用情報）
  sort_order    int  not null default 99,
  warn_qty      int,                           -- 警告数量。在庫がこの値以下で「発注依頼してください」
  disabled      boolean not null default false, -- 無効（選択肢に出さない。過去の記録は残す）
  -- 「予備40型（在庫管理外）」のように在庫を管理しない備品。一覧では在庫欄を出さない
  track_stock   boolean not null default true,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists equipment_items_category_idx
  on equipment_items (category_code, sort_order, item_no);

-- テナント（正は FileMaker の検針記録DB。当システムは同期したコピーを持つ）
create table if not exists equipment_tenants (
  -- 請求先コード（8桁。99990001 = 共用エリア）
  billing_code    text primary key,
  name            text not null,               -- 正式名称
  floor           text,                        -- 階（共用エリアは空）
  moved_out       boolean not null default false,  -- 退去済み
  -- ここだけ当システム側の設定値。同期で上書きしない
  default_item_id uuid references equipment_items(id),
  note            text,                        -- 検針に関する備考（同期対象）
  source          text not null default 'filemaker',  -- filemaker / manual
  synced_at       timestamptz,                 -- 最後に FileMaker から取り込んだ日時
  -- 同期結果に含まれなくなった行の目印（勝手に消さず、選択肢から外すだけにする）
  missing_since   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists equipment_tenants_floor_idx on equipment_tenants (floor, billing_code);

-- 入出庫（このテーブルが在庫の唯一の正）
create sequence if not exists equipment_txn_no_seq;

create table if not exists equipment_transactions (
  id          uuid primary key default gen_random_uuid(),
  -- 問い合わせ・調査で特定しやすい短い連番（tasks.task_no と同じ考え方。画面上は「E-123」）
  txn_no      bigint not null unique default nextval('equipment_txn_no_seq'),
  item_id     uuid not null references equipment_items(id),
  kind        text not null check (kind in ('in', 'out')),
  -- in : procure=調達 / deferred=繰延登録 / adjust=在庫調整
  -- out: tenant=テナント設置 / common=共用部設置 / replace=新規入替 / discard=不良品処分
  reason      text not null check (reason in
                ('procure','deferred','adjust','tenant','common','replace','discard')),
  occurred_at timestamptz not null,            -- 入出庫日時（日付＋時刻）
  -- 入庫は正（在庫調整のみ負を許す）／出庫は正。0 は許さない
  quantity    int not null check (quantity <> 0),
  supplier    text,                            -- 調達先（入庫）
  -- テナント設置。名称は記録時点のスナップショットも持つ（テナントの改称・退去後も帳票が崩れない）
  tenant_code text references equipment_tenants(billing_code),
  tenant_name text,
  floor       text,                            -- 共用部設置の階（テナント設置時はテナントの階を写す）
  location    text,                            -- 共用部設置の場所（喫煙室 / 通路 / 玄関ホール …）
  staff_name  text,                            -- 担当者（複数名は「廣畑・岡田」のように1欄）
  signature_key text,                          -- 署名画像の Storage キー（テナント設置のみ）
  signed_at   timestamptz,                     -- 受領タイムスタンプ
  note        text,
  created_by  uuid references users(id),
  updated_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- 区分と理由の整合（入庫の理由で出庫を登録する等の取り違えを DB 側でも止める）
  constraint equipment_txn_kind_reason check (
    (kind = 'in'  and reason in ('procure','deferred','adjust')) or
    (kind = 'out' and reason in ('tenant','common','replace','discard'))
  ),
  -- 負数は在庫調整のときだけ
  constraint equipment_txn_negative_only_adjust check (quantity > 0 or reason = 'adjust'),
  -- 署名はテナント設置のときだけ持つ
  constraint equipment_txn_signature_only_tenant check (signature_key is null or reason = 'tenant')
);
create index if not exists equipment_txn_item_idx     on equipment_transactions (item_id, occurred_at desc);
create index if not exists equipment_txn_occurred_idx on equipment_transactions (occurred_at desc);
create index if not exists equipment_txn_tenant_idx   on equipment_transactions (tenant_code, occurred_at desc);

drop trigger if exists equipment_transactions_set_updated_at on equipment_transactions;
create trigger equipment_transactions_set_updated_at before update on equipment_transactions
  for each row execute function set_updated_at();

-- 既存方針どおり anon/authenticated からは一切触れない（Worker の service role 経由のみ）
alter table equipment_categories   enable row level security;
alter table equipment_items        enable row level security;
alter table equipment_tenants      enable row level security;
alter table equipment_transactions enable row level security;
revoke all on equipment_categories, equipment_items, equipment_tenants, equipment_transactions
  from anon, authenticated;
```

### 4-2. 集計ビュー

PostgREST から `group by` 相当が使えないため、集計はビューで用意する（既存の日報機能では使っていない
手法だが、ここは行数が増える一方の入出庫を毎回全件取って JS で集計するより素直で速い）。

```sql
-- 現在庫
create or replace view equipment_stock as
  select i.id as item_id,
         coalesce(sum(case when t.kind = 'in' then t.quantity else -t.quantity end), 0)::int as stock_qty,
         max(t.occurred_at) as last_moved_at
    from equipment_items i
    left join equipment_transactions t on t.item_id = i.id
   group by i.id;

-- 年計（画面の「年計： 52  8」）。年は JST 基準
create or replace view equipment_yearly_totals as
  select item_id,
         extract(year from (occurred_at at time zone 'Asia/Tokyo'))::int as year,
         sum(case when kind = 'in'  then quantity else 0 end)::int as in_qty,
         sum(case when kind = 'out' then quantity else 0 end)::int as out_qty
    from equipment_transactions
   group by 1, 2;

revoke all on equipment_stock, equipment_yearly_totals from anon, authenticated;
```

> **注意（過去の教訓の適用）**: 関数・ビューを後から作り替えるときは、`create or replace` だけでは
> 権限が既定（PUBLIC）に戻ることがある。`api_usage` の `add_api_usage()` で実際に踏んだ問題なので
> （HANDOFF「経緯の要約」31番）、**作成・変更のたびに `revoke` を必ずセットで流す**。

### 4-3. 署名画像の保管

- 既存バケット **`report-photos`**（非公開）を再利用し、キーは `equipment/signatures/<txn_id>.png`
- 新バケットを作らない理由: バケット追加は `worker/lib/storage.js` の改修（バケット名の引数化）と
  従量課金画面の使用量集計の見直しを伴う一方、署名 PNG は 1 枚 10〜30KB 程度で、
  年間数百枚でも数MB。分ける実益が薄い
- 取得は既存の写真と同じく **JWT 認証を通った Worker 経由のみ**（`GET /api/equipment/signature?txn_id=…`）

---

## 5. 画面設計

**すべて `docs/ui-standard.md` に準拠する。** 具体的には:
骨格は `.ui-page` → `.ui-container` → `.ui-toolbar`、緑＝現在地／青＝操作、`.btn-primary` は1画面1つ、
アイコンのみのボタンは `title` + `aria-label`、削除は `ConfirmDeleteButton`、モーダルは `.ui-overlay` /
`.ui-modal` + `useBodyScrollLock()`、高さは `max-height: 100%`（`vh`/`dvh` を使わない）、
CSS に生値を書かない。

### 5-0. ヘッダのセクション切替

`[ タスク ｜ 日報 ]` を `[ タスク ｜ 日報 ｜ 備品 ]` にする（`AppHeader.jsx`）。

- 現在の `inReports` 真偽判定を `section = 'tasks' | 'reports' | 'equipment'` の3値に変える。
  デスクトップ用・モバイル用に**同じ nav が2箇所ある**ので両方直す
- ハンバーガーメニューの中身も section で出し分ける（備品セクションでは「在庫一覧」「備品マスタ」
  「テナント一覧」「従量課金事項」）
- **owner（小泉産業様）には出さない。** 備品は栄和の社内管理であり、日報のような提出物ではない
  （→ 12章の確認事項⑦。もし見せる場合は日報と同じ「閲覧のみ」で対応できる）
- ⚠ **要検証**: iPhone 幅（375px）でヘッダは既に2行に折り返しており、セグメントが3つになると
  2行目が窮屈になる可能性がある。`.app-switch .ui-segmented-btn` の左右パディングは狭幅で既に
  詰めてあるので、収まらなければラベル短縮ではなくパディング/フォントサイズのトークン変更で対応する
  （実機幅での確認を「出す前のチェックリスト」に含める）

### 5-1. 在庫一覧 `/equipment`（このセクションのホーム）

現行の「入出庫記録」に相当するが、**現行のような1画面全部入りの密なリストにはしない。**
現行は 27 インチの Mac 画面が前提で、iPhone ではそのままでは使えないため、
**「在庫を見る」と「履歴を見る」を分ける**。

```
[ 在庫 ]                                        [ 入庫 ] [ 出庫 ]
  ┌────────────────────────────────────────┐
  │ A4 蛍光灯 40                            │  ← カテゴリ見出し
  │  FLR40SW (白色)      FLR40SW/M/36    44 │  ← 行タップで履歴へ
  │  FLR40EX (昼白色)    FLR40S EX-N/M/36 0 │  ← 赤バッジ＋「発注依頼」
  └────────────────────────────────────────┘
```

- ツールバー: 左＝タイトル「備品」、右＝`入庫`（`.btn-plain`）と `出庫`（`.btn-primary`。現場で一番使う操作）
- 行は**カテゴリごとにグルーピング**（`.ui-sticky-head-2` でカテゴリ見出しを固定表示）
- 在庫が `warn_qty` 以下なら `.ui-badge.is-danger` ＋「発注依頼してください」（現行と同じ文言）
- `disabled` の備品は既定で非表示（トグルで表示）。`track_stock=false` は在庫欄を「—」にする
- **横スクロールする要素の中で `.ui-sticky-head` 系を使わない**
  （`sticky-header-overflow-trap` スキル参照。過去に3回踏んだ罠）

### 5-2. 備品の履歴 `/equipment/items/:itemNo`

行タップで開く。現行の明細部分に相当。

- 見出し: 備品名・製品番号・**現在庫**・年計（入庫/出庫）
- 期間フィルタ: `3ヶ月 / 1年 / 全期間`（既定 3ヶ月。現行の「3ヶ月前から表示する」に相当）
- 明細: `日付 / 入庫 / 出庫 / 残 / 設置先 / 担当 / 署名アイコン`。行タップで詳細モーダル（＝修正）
- 入庫は緑字・出庫は青字（現行の色分けを踏襲）。ただし**トークンの色**を使う（生値を書かない）
- **署名列は3状態**（署名あり＝サムネイル／**署名待ち＝バッジ**／対象外＝空欄）。テナント設置なのに
  未署名の行は「署名待ち」を出し、そこから直接署名モーダルを開ける（5-5。署名を必須にしない代わりの安全網）

### 5-3. 入庫モーダル

現行の「入庫登録」。`.ui-modal.is-sm`。

| 項目 | UI |
|---|---|
| 入庫日時 | `datetime-local`（既定＝現在。残留塩素の測定日時と同じ作り） |
| 入庫理由 | 択一ボタン `調達 / 繰延登録 / 在庫調整`（残留塩素の「測定施設」と同じ形。セグメントは使わない※） |
| 備品 | `.ui-select`（カテゴリ見出し付き `<optgroup>`。`disabled` は出さない） |
| 調達先 | `.ui-input` ＋ 過去値の `<datalist>` |
| 入庫数量 | 数値。**在庫調整のときだけマイナスを許可**する |
| 在庫の変化 | `44 → 94` と自動表示（現行の「入庫前在庫数／入庫後在庫」） |
| 担当者 | `.ui-input` ＋ 過去値の `<datalist>`（後述 5-7） |
| 備考 | `.ui-textarea`（プレースホルダ「在庫調整理由など」） |

※ `.ui-segmented` は「同じ対象の見せ方の切替」に使う部品で、**データの入力値には使わない**
（`ui-standard.md` 3章）。理由の選択は択一ボタン（`.btn-plain.is-active`）で表現する。

### 5-4. 出庫・設置モーダル

現行の「出庫・設置記録」。理由によって入力項目が切り替わる。

| 項目 | テナント設置 | 共用部設置 | 新規入替 | 不良品処分 |
|---|---|---|---|---|
| 設置先テナント | ○（必須） | — | **—** | — |
| 設置階・設置場所 | 自動（テナントの階） | ○（必須） | **—** | — |
| 備品・数量・担当者・備考 | ○ | ○ | ○ | ○ |
| **受領サイン** | **○（任意）** | — | — | — |

> **新規入替は「共通項目＋備考」だけ（2026-08-11 確定。確認事項②）。** 当初は「テナント設置と
> 同じ項目」と仮置きしていたが、実際の運用では**備考しか入力しない**とのことなので、設置先の
> テナント・階・場所は出さない。→ 設置先も残す必要があるかは確認事項③'で最終確認する

- **テナント選択**: 件数が数十件あるため、`.ui-select` ではなく**検索できる選択 UI**（入力で絞り込む
  `<input list>` + `<datalist>`）にする。`退去済み` は既定で候補から外す。
  選択するとテナントの**階**と**デフォルト備品**を自動で埋める（デフォルト備品はテナントマスタの
  設定値。現行の `A20_テナント備品関連::デフォルト備品ID` と同じ役割）
- **設置場所（共用部）**: 過去に使った場所の `<datalist>`（喫煙室 / 通路 / 玄関ホール …）＋自由入力
- **在庫の変化**: `44 → 42` を自動表示。**0 を下回る場合は赤字で警告するが保存はできる**（3-2）
- 保存は `.btn-primary`「記録する」。フッタは左＝削除（`ConfirmDeleteButton`）／右＝キャンセル・記録する

### 5-5. 署名モーダル（テナント設置）

**この機能の肝。** iPad / スマホで指・Apple Pencil で手書きしてもらう。

- `.ui-modal` の上に重ねる入れ子モーダル（`--z-modal-nested`）。`useBodyScrollLock()` は
  入れ子でも数を数えるので、内側を閉じても外側のロックは外れない（`ui-standard.md` 3章）
- **外部ライブラリは使わない。** `<canvas>` + Pointer Events（`pointerdown/move/up`）で実装する。
  この規模なら数十行で済み、依存を増やす方がリスクが大きい（既存の方針＝ゼロ依存を踏襲）
- 実装上の注意点（先に潰しておく）:
  1. `touch-action: none` を canvas に指定する。付けないと**書いている最中に画面がスクロール**する
  2. `devicePixelRatio` を掛けた実サイズで canvas を作り、CSS サイズと分けて持つ（Retina でぼやけない）
  3. 線は `lineCap/lineJoin = 'round'`、`lineWidth` は 2〜3 の固定（筆圧は使わない）
  4. `pointercancel` / `pointerleave` でもストロークを閉じる（iOS で指が枠外に出たとき）
  5. 保存時に**描画範囲を切り出して余白を詰め**、長辺 600px 程度に縮小して `canvas.toBlob('image/png')`。
     背景は透過ではなく**白**で塗る（帳票・PDF に載せたときに黒背景に潜らないように）
  6. `取消`（消して書き直し）と `閉じる` を分ける
  7. 横向き（landscape）でも枠が潰れないよう、高さは `max-height: 100%` の枠内で比率固定にする

#### 署名は必須にしない。「あとから署名だけ足す」流れを正面から作る（2026-08-11 確定。確認事項④）

> 「テナントの署名は必ずしてもらえるが、システム上は必須にしなくてよい。
> **先に入力しておいて後から署名だけもらうこともある**」との回答による。

これは制約をゆるめるだけの話ではなく、**運用フローが1本増える**ため設計に反映する。

- **保存フローを2通りにする**:
  1. その場で署名 → 署名 PNG を入出庫レコードの保存と**同時**に送る（multipart。当初の想定どおり）
  2. **先に記録だけ保存 → 後日、署名だけ足す** → 既存レコードに署名を後付けする専用の口を用意する
     （`POST /api/equipment/transactions/:id/signature`）。`signed_at` には**署名を受け取った時刻**を入れる
     （記録の入力時刻とは別物なので、`created_at` とは必ず分けて持つ）
- **未署名が埋もれないようにする**: 一覧・履歴で**「署名待ち」が一目で分かる**ようにする
  （署名列にバッジを出す＋在庫一覧のツールバーに「署名待ちのみ」の絞り込み）。
  必須をやめる以上、これが無いと「もらい忘れ」に気づけない。**必須化の代わりに置く安全網**という位置づけ
- **署名を足す導線**: 一覧の該当行 → 履歴（5-2）または編集モーダルから「署名をもらう」ボタン →
  この署名モーダルを開く。iPad を持って現地でテナントを回る使い方を想定し、**記録を開き直さなくても
  署名だけ入れて閉じられる**ようにする
- **修正ロックとの関係**（9章）: 「署名済みは staff は修正不可」は現行どおり維持する。
  署名が後から付く運用なので、**未署名の間は staff も直せる**（現行 FileMaker と同じ挙動）。
  署名を足した時点でロックがかかる、という順序になる
- ⚠ **実機確認が必須**。過去、モーダル・写真まわりは Chromium では再現しない iOS 固有の不具合を
  何度も踏んでいる（HANDOFF 40・56〜60・112番）。**iPad（Pencil / 指）と iPhone の両方**で確認する

### 5-6. 備品マスタ `/equipment/items`

- カテゴリごとにグルーピングした一覧。列は現行と同じ（備品ID / 表示順 / 備品名 / 製品番号 / 警告数量 /
  無効 / 在庫数）。行タップで編集モーダル、ツールバー右に `備品を追加`
- **カテゴリマスタ**は件数が7件と少ないため専用画面を作らず、この画面のツールバーから開くモーダルで
  一覧・追加・編集する

### 5-7. テナント一覧 `/equipment/tenants`

- FileMaker から同期した内容の**参照**（階・請求先コード・正式名称・退去済み・備考）
- 当システムで編集できるのは **デフォルト備品** だけ（現行の注記と同じ）
- ツールバーに `同期`ボタンと「最終同期: 2026-08-11 04:00」の表示。同期は 7-1

### 5-8. 担当者の選択（要件「既存データから選択、または、新規入力」）

過去の入出庫の `staff_name` から**重複を除いた候補**を返す API を用意し、
`<input list>` + `<datalist>` で「選ぶことも、新しく打つこともできる」形にする。
違反車両の地域・メーカー・車種で既に使っている方式（`daily-report-plan.md` Phase 4）と同じで、
利用者にとっても操作が揃う。

> タスク管理の `settings.assignees`（担当者名リスト）とは**別扱いにする**。備品の設置担当は
> 協力会社を含む現場の作業者で、タスクの割り当て先とは母集団が違うため（→ 確認事項⑧）。

---

## 6. API 設計（Worker）

`worker/lib/equipment.js` に新設し、`worker/index.js` の `route()` に分岐を足す。
既存と同じく **JWT 必須・書き込みは owner 不可**。外部連携用の 6-2 だけが例外。

### 6-1. 社内向け（JWT）

| メソッド/パス | 内容 |
|---|---|
| GET `/api/equipment/items` | 備品マスタ＋現在庫＋年計。`include_disabled=1` で無効も含む。在庫一覧・各モーダルの選択肢の元 |
| POST/PATCH/DELETE `/api/equipment/items` | 備品の追加・変更・削除（入出庫が1件でもあれば削除不可。`disabled` を促す） |
| GET/PUT `/api/equipment/categories` | カテゴリの一覧・丸ごと差し替え（定型文と同じ流儀） |
| GET `/api/equipment/transactions` | 入出庫の一覧。`item_no=` / `from=` / `to=` / `limit=`。各行に**その時点の残高**を付けて返す |
| POST `/api/equipment/transactions` | 入出庫の登録。`multipart/form-data`（署名 PNG を同送**できる**。署名なしでも登録可）。`kind`/`reason` の整合はサーバー側でも検証 |
| PATCH `/api/equipment/transactions` | 修正（9章の修正ロックをサーバー側で判定） |
| DELETE `/api/equipment/transactions?id=…` | 削除（同上。署名画像の実体も消す） |
| **POST `/api/equipment/transactions/:id/signature`** | **既存レコードへの署名の後付け**（5-5。「先に入力して後から署名だけもらう」運用のため）。未署名のレコードにのみ許可し、成功したら `signed_at` を立てる＝以後 staff は修正不可になる |
| GET `/api/equipment/signature?txn_id=…` | 署名画像の本体（非公開バケットなのでこの経路のみ） |
| GET `/api/equipment/suggest?field=staff\|location\|supplier` | 過去値の候補（`<datalist>` 用。重複除去・使用頻度順） |
| GET `/api/equipment/tenants` | テナント一覧（`include_moved_out=1` で退去済みも） |
| PATCH `/api/equipment/tenants` | `default_item_id` の設定（同期対象外の当システム独自項目） |
| POST `/api/equipment/tenants/sync` | FileMaker からの手動同期（7-1） |

### 6-2. FileMaker 向けの公開 API（APIキー認証）

**要件「FileMaker のアプリから、テナントに設置したランプ情報を年月指定で取得」への回答。**

```
GET /api/equipment/installations?month=2026-08[&scope=tenant|common|all][&tenant_code=…]
Header: X-API-Key: <EQUIPMENT_API_KEY>
```

```json
{
  "month": "2026-08",
  "generated_at": "2026-09-01T00:05:00+09:00",
  "count": 2,
  "installations": [
    {
      "txn_no": 1234,
      "installed_at": "2026-08-10T10:22:00+09:00",
      "tenant_code": "73050011",
      "tenant_name": "静岡県大阪事務所",
      "floor": "1",
      "item_no": 2,
      "item_name": "FLR40SW (白色)",
      "product_code": "FLR40SW/M/36",
      "quantity": 2,
      "staff_name": "西川",
      "signed": true,
      "note": null
    }
  ]
}
```

セキュリティ設計（**これは JWT の外側に開く唯一の口なので厚めに**）:

1. `X-API-Key` を Worker シークレット `EQUIPMENT_API_KEY` と**タイミング安全比較**（長さ比較＋
   全バイト XOR。早期 return しない）
2. **送信元 IP の許可リスト**（`EQUIPMENT_API_ALLOW_IPS`。`CF-Connecting-IP` で判定）。
   FileMaker Server は固定の自社回線から出るため、ここは実際に効く防御になる。
   未設定なら IP 制限なし（＝キーのみ）で動くようにし、設定を必須にはしない
3. **読み取り専用**。書き込み系のパスは一切生やさない
4. KV（`LOGIN_ATTEMPTS` と同じ仕組み）で**レート制限**（例: 同一 IP 60回/時）
5. 返す情報は**テナント名・階・備品・数量・担当者名まで**。署名画像そのものは返さない（`signed` の
   真偽のみ）。個人情報を最小化する既存方針に沿う
6. 呼び出しは `activity_logs` に1行残す（呼び出し頻度は月数回想定なので溢れない）
7. キーの生成・ローテーション手順を HANDOFF に記載する（GitHub Secrets → Deploy 実行）

FileMaker 側の呼び出し例（`Insert from URL`、cURL オプション）:

```
"-X GET
--header " & Quote("X-API-Key: ***") & "
--header " & Quote("Accept: application/json")
```

> **なぜ JWT ではなく API キーか**: JWT は人のログインに紐づく30日期限のトークンで、
> 機械間連携に使うと期限切れで静かに止まる。用途を分けたほうが運用が破綻しない。

---

## 7. FileMaker 連携

### 7-1. テナントマスタの取得（Pull・FileMaker Data API）

要件「テナントマスタは FileMaker Server 上のものから FileMaker API で取得したい」への回答。

**方式**: Cloudflare Worker → FileMaker Data API（`daily-report-plan.md` 6-2 の**方式B**）。

```
POST   https://<host>/fmi/data/vLatest/databases/<db>/sessions       （Basic認証 → トークン取得）
GET    https://<host>/fmi/data/vLatest/databases/<db>/layouts/<layout>/records?_limit=1000
DELETE https://<host>/fmi/data/vLatest/databases/<db>/sessions/<token>
```

**同期の作り**:
- **1日1回（JST 04:00）**、既存の cron（5分ごと起動 → 時刻でゲート）から実行。加えて画面の `同期` ボタンで手動実行
- 取り込みは `billing_code` を突合キーに **upsert**。`default_item_id` は**上書きしない**
- 同期結果に無くなった行は**消さずに** `missing_since` を立て、選択肢から外すだけにする
  （過去の入出庫が参照しているため。`tenant_name` のスナップショットも別途持っている）
- **FileMaker が落ちていても現場の入力は止まらない**。当システムは同期済みのコピーで動くため、
  同期失敗はログとテナント一覧の「最終同期」表示に出るだけ

**必要な準備（栄和側／FileMaker 側の作業。これが前提条件になる）**:

| # | 内容 | 誰が |
|---|---|---|
| 1 | 検針記録DB で Data API 用の**専用アカウント**を作る（読み取り専用の権限セット、拡張アクセス権 `fmrest` を有効） | FileMaker 管理者 |
| 2 | テナント一覧を返す**専用レイアウト**を用意（階・請求先コード・正式名称・退去済み・備考のみ） | FileMaker 管理者 |
| 3 | FileMaker Server の **Data API を有効化** | FileMaker 管理者 |
| 4 | **外部からの HTTPS 到達性**と**正式な証明書**（自己署名だと Worker からの接続が失敗する） | ネットワーク管理者 |

⚠ **最大の論点はこの 4 番。** Cloudflare Workers の送信元 IP は固定でないため、
**FileMaker Server 側で IP 制限をかけられない**（`daily-report-plan.md` 6-2 で方式Bの弱点として
挙げていたのはこの点）。対策として次のいずれかを推奨する。

| 対策 | 内容 | 評価 |
|---|---|---|
| **A. Cloudflare Tunnel（推奨）** | 社内サーバーに `cloudflared` を入れ、**外向きの接続だけ**で Cloudflare に繋ぐ。FileMaker Server のポートをインターネットに開けずに済み、Cloudflare Access のサービストークンで Worker からのアクセスだけを通せる | ポート開放ゼロ。追加費用なし（無料枠） |
| B. そのまま公開＋強い認証 | HTTPS 公開し、専用アカウント＋長いパスワードのみで守る | 作業は最小だが、FileMaker Server が常時インターネットから叩ける状態になる |
| C. Push に切り替え | FileMaker 側のスクリプトからテナント一覧を当システムへ送る（6-2 と同じ APIキー方式の受け口を作る） | サーバーを一切公開しない。**FileMaker 側の改修が要る** |

**推奨は A。** Bは、FileMaker Server の脆弱性が出たときに直接影響を受ける。
Aが難しく、FileMaker 側の改修工数が取れるなら C も良い選択（送受信の向きが揃うので構成も単純になる）。

> **【確定】方式A（Cloudflare Tunnel）で進める（2026-08-11）。**
> 「オンプレなので技術的に可能なことは全て当方判断で設定できる。バージョンは最新 2026」との回答による。
> FileMaker **2026** は Data API を標準搭載しているため、上表の準備1〜3（専用アカウント・専用レイアウト・
> Data API 有効化）はいずれもサーバー管理画面と FileMaker Pro の操作だけで完了する。
> 準備4（外部到達性・証明書）は Cloudflare Tunnel を使うことで**ポート開放も公的証明書の取得も不要**になる
> （`cloudflared` が外向き接続だけで Cloudflare に繋ぐため、サーバーは非公開のままでよい）。
> 実装フェーズに入る際、当方から**具体的な手順（cloudflared の導入・Access サービストークンの発行・
> 権限セットと拡張アクセス権 `fmrest` の設定・レイアウトに置くフィールド）を手順書として提示する**。

**Worker シークレット（追加）**: `FM_DATA_API_HOST` / `FM_DATA_API_DB` / `FM_DATA_API_LAYOUT` /
`FM_DATA_API_USER` / `FM_DATA_API_PASSWORD`（＋Tunnel 採用時は `FM_ACCESS_CLIENT_ID` /
`FM_ACCESS_CLIENT_SECRET`）

### 7-2. 設置実績の提供（Push 方向・6-2 の API）

FileMaker 側から `Insert from URL` で 6-2 を叩く。**当システム側の作業だけで完結**し、
FileMaker Server を公開する必要もない。7-1 の準備を待たずに先行して出せる。

---

## 8. 初期データの移行（FileMaker からの CSV）

要件「初期データは FileMaker からダウンロードした CSV を引き渡す」への回答。

### 8-1. 受領したい CSV（4本）

| ファイル | 想定列 |
|---|---|
| カテゴリマスタ | カテゴリコード / カテゴリ名称 / 備考 |
| 備品マスタ | 備品ID / カテゴリコード / 表示順 / 備品名 / 製品番号 / 警告数量 / 無効 |
| テナントマスタ | 階 / 請求先コード / 正式名称 / 退去済み / デフォルト備品ID / 備考 |
| 入出庫記録 | 入出庫日付 / 入出庫時刻 / 区分 / 理由 / 備品ID / 数量 / 調達先 / 設置先テナント(請求先コード) / 階 / 設置場所 / 担当者 / 備考 / 受領タイムスタンプ |

- **文字コードは Shift_JIS(CP932) で構いません**（FileMaker の既定書き出し）。取込側で UTF-8 に変換する
- **過去の署名画像は移行しない**（CSV に載らない。現行 FileMaker を参照用に残す前提）→ 確認事項⑤
- 実際の列名・並びは書き出したファイルのままで構いません。**ヘッダ行付きで**いただければ、
  取込スクリプト側で対応付けます

### 8-2. 取込スクリプト

`scripts/import-equipment-csv.mjs`（ローカル実行。CI には載せない）

- Supabase の service role キーを環境変数で受け取り、`--dry-run` で**件数と差分だけ表示**してから本実行
- 突合キー: カテゴリ=`code` / 備品=`item_no` / テナント=`billing_code` / 入出庫=（日時 + 備品 + 数量 + 区分）
- **何度流しても二重登録にならない**こと（upsert）を必須要件にする
- 取込後の検証: **CSV の在庫数と、当システムが入出庫から算出した在庫数が全備品で一致すること**。
  ここがズレたら移行は失敗とみなす（データ移行の合否判定をこの1点に集約する）

### 8-3. 過去分をどこまで入れるか

現行画面の「3ヶ月前から表示」「年計」から、**年間の入出庫は多くても数百件**と見える。
全期間を入れても DB 的にまったく負担にならないため、**全件移行を推奨**（年計が過去年も正しく出る）。

> **【確定】全期間を移行する（2026-08-11。確認事項⑥）。** 「過去は必要に応じて全件移行可能」との回答による。
> なお**署名画像は CSV に含まれない**ため、これとは別の話として残る（→ 確認事項⑤）。

---

## 9. 権限・修正ロック

現行画面に明記されている一般ユーザ制約を、**サーバー側で**実装する（画面側の制御は補助）。

| 操作 | staff | admin | owner |
|---|---|---|---|
| 閲覧 | ○ | ○ | 画面を出さない（→確認事項⑦） |
| 入庫の登録 | ○ | ○ | × |
| **入庫の修正** | **×**（登録後は不可） | ○ | × |
| 出庫の登録 | ○ | ○ | × |
| **署名済み出庫の修正** | **×** | ○ | × |
| 未署名の出庫の修正 | ○ | ○ | × |
| **前日以前のレコードの削除** | **×** | ○ | × |
| 当日登録分の削除 | ○ | ○ | × |
| マスタ（備品・カテゴリ）の編集 | ○ | ○ | × |

- 判定は `worker/lib/equipment.js` の共通関数に閉じ込める（`canEditTransaction(auth, txn)`）
- 拒否時は 403 と**理由の分かるメッセージ**を返す（「受領サイン済みのため修正できません。管理者に依頼してください」）
- **署名は後から付く前提**（5-5。確認事項④）。したがって上表の「署名済み／未署名」は
  レコード作成時ではなく**その時点の `signed_at` の有無**で判定する。未署名の間は staff も修正でき、
  **署名を足した瞬間からロックがかかる**。なお「署名を足す」操作自体は、未署名レコードに対して
  staff にも許可する（そうしないと後日もらう運用が回らない）
- 現行の「修正ロック」チェックボックスは、**誤操作防止のための画面側トグル**として同等機能を用意する
  （既定オン。オフにしないと一覧から編集モーダルを開けない）→ 確認事項⑨

---

## 10. 非機能

| 観点 | 方針 |
|---|---|
| セキュリティ | 6-2 の公開 API 以外は既存どおり JWT。公開 API は APIキー＋IP制限＋レート制限＋読み取り専用。設計書8章に追記 |
| ストレージ | 署名 PNG は 1枚 10〜30KB。年間数百枚でも数MB で、無料枠 1GB にほぼ影響しない。従量課金画面の使用量表示にはそのまま合算される |
| AI コスト | **この機能では Claude を使わない**（増加ゼロ）。将来、伝票の写真読み取り等を足すなら別途 |
| PWA | 変更なし。SW には手を入れない（fetch ハンドラを足さない＝既存の鉄則） |
| CSP | 変更なし。署名は canvas → Blob で完結し、外部への接続を増やさない。FileMaker への接続は**すべて Worker 側**で行うためブラウザの `connect-src 'self'` に触れない |
| 通知 | （任意）在庫が警告数量を下回ったら既存の Web Push で知らせる、は少ない追加で実現できる → 確認事項⑩ |

---

## 11. 開発フェーズと見積り

各フェーズは独立してリリースでき、**現行 FileMaker と並行運用しながら**進める（日報と同じ進め方）。

| Phase | 内容 | 前提 | 目安 |
|---|---|---|---|
| **0. 準備** | 12章の確認事項の回答、CSV 4本の受領、FileMaker 側の到達性方針の決定 | — | 打ち合わせのみ（**①②④⑥は2026-08-11に回答済み**。到達性は方式Aで確定） |
| **1. 基盤＋在庫と入出庫（共用部まで）** | DB・ビュー / ヘッダに「備品」追加 / 在庫一覧 / 履歴 / 入庫モーダル / 出庫（共用部・不良品処分） / 備品・カテゴリマスタ / CSV 取込スクリプト | Phase 0 の CSV | 1〜2セッション |
| **2. テナント設置＋署名** | テナント一覧（CSV 取込分） / 出庫（テナント設置・新規入替） / **署名キャプチャ** / 署名の表示・保管 / **署名の後付け（後日もらう運用）と「署名待ち」の可視化** | Phase 1 | 1〜2セッション |
| **3. 権限・修正ロック・仕上げ** | 9章の権限判定 / 修正ロック / 在庫警告表示 / 実機フィードバック対応 | Phase 2 | 1セッション |
| **4. 設置実績の提供 API** | 6-2 の公開 API / APIキー発行 / FileMaker 側からの疎通確認 | Phase 2 | 0.5〜1セッション |
| **5. テナントマスタ同期** | 7-1 の Data API 連携 / 日次同期 / 手動同期ボタン | **FileMaker 側の準備（7-1 の表 1〜4）** | 1セッション＋先方作業 |
| **6. 並行運用と切替判断** | 実運用での突き合わせ、現行 FileMaker アプリの停止判断 | 全 Phase | 運用期間 |

- **Phase 4 は Phase 5 を待たない。** 当システム側だけで完結するので、テナントマスタの同期が
  整う前でも FileMaker 側から実績を引けるようにできる
- Phase 1・2 の間はテナントマスタが**CSV 取込の静的コピー**になる。新規入居・退去は
  テナント一覧画面から手で直せるようにしておき（`source='manual'`）、Phase 5 で自動化する
- 「1セッション」= これまでの日報の各 Phase と同程度の作業量（実装＋ローカル検証＋文書更新）。
  **実機確認とフィードバック対応の往復は別途**（日報では毎回2〜3ラウンド発生している）

---

## 12. 確認事項

### 12-1. 回答済み（2026-08-11）

| # | 内容 | **回答** | 設計への反映 |
|---|---|---|---|
| ① | FileMaker Server の外部到達性（7-1 の A/B/C） | **オンプレで技術的に可能なことは全て設定可能。バージョンは最新 2026** | **方式A（Cloudflare Tunnel）で確定**。FileMaker 2026 は Data API を標準搭載しており前提を満たす。7-1 の準備1〜4は当方から手順を提示する（→ 7-1） |
| ② | 「新規入替」「繰延登録」の入力項目 | **新規入替の入力は備考のみ。繰延は通常の入荷と同じ項目が使えればOK**（移行時の入力で使う） | **新規入替＝共通項目（備品・数量・担当者）＋備考のみ**に変更（当初の仮置き「テナント設置と同じ項目」は誤りだったため訂正）。**繰延登録＝調達と同じ項目**（仮置きどおり）（→ 5-4） |
| ③ | 「新規入替」に設置先の入力は要るか | ②の回答（備考のみ）より **不要と解釈**（→ 12-2 で最終確認） | 新規入替ではテナント選択・設置階/場所を出さない（→ 5-4） |
| ④ | テナント設置で署名は必須か | **署名は必ずもらえるが、システム上は必須にしなくてよい。先に入力しておいて後から署名だけもらうこともある** | **必須をやめ、「あとから署名だけ足せる」導線を設計に追加**。保存とサインの同時送信を前提にしていた作りを改める（→ 5-5・9章）。これは単なる必須解除ではなく**運用フローの追加**なので影響が大きい |
| ⑥ | 入出庫の過去データの移行範囲 | **必要に応じて全件移行可能** | **全期間移行で確定**（→ 8-3） |

### 12-2. 未回答（引き続きご判断をお願いしたい）

| # | 内容 | こちらの推奨 |
|---|---|---|
| ③' | ②の「新規入替は備考のみ」は、**設置先（テナント／共用部）も入力しない**という理解でよいか | 入力しない前提で進める。もし「どこに入れ替えたか」を残す必要があれば、共用部設置と同じ階・場所欄を足す |
| ⑤ | **過去の署名画像**は移行するか（CSV には載らないため、移行するなら別途の書き出しが要る） | 移行しない（過去分は現行 FileMaker を参照用に残す）。⑥で「全件移行可能」とのことなので、署名画像も含めるかを別途ご判断ください |
| ⑦ | **owner（小泉産業様）に備品セクションを見せるか** | 見せない（社内の在庫管理のため）。見せる場合は日報と同じ閲覧のみ |
| ⑧ | 担当者の候補は**過去の入出庫から**でよいか（タスク管理の担当者リストとは別で） | 過去の入出庫から。現場の作業者はタスクの担当者と母集団が違うため |
| ⑨ | 現行の「**修正ロック**」チェックボックスは残すか | 残す（既定オン）。誤タップでの編集を防ぐ意味があるため |
| ⑩ | 在庫が警告数量を下回ったとき、**Web Push で通知**するか | あると便利（既存の通知基盤で少ない追加で実現できる）。要否をご判断ください |
| ⑪ | 「**各種出力**」で現在どんな帳票を出しているか | 今回は範囲外。必要なら要件を伺って別途 |
| ⑫ | CSV の**列名・件数**（8-1 の想定と合っているか） | 実ファイルをいただければこちらで合わせます |

---

## 13. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| **FileMaker Server の公開**（7-1） | サーバーが常時インターネットから到達可能になる | Cloudflare Tunnel を推奨。決まるまで Phase 5 に着手しない。Phase 1〜4 は影響を受けない |
| **署名が iOS 実機で書けない／ずれる** | この機能の中心が使えない | Pointer Events・`touch-action: none`・DPR 対応を最初から入れる。**iPad と iPhone の実機確認を Phase 2 の完了条件にする**。過去、モーダル・写真は Chromium で再現しない iOS 固有の不具合を複数回踏んでいる |
| **在庫数が現行と合わない** | 移行の信頼性が崩れる | 8-2 の検証（全備品で在庫一致）を移行の合否判定にする。合わない場合は原因（重複行・区分の取り違え）を特定してから本番投入 |
| **公開 API のキー漏洩** | 設置実績が第三者に読まれる | IP 制限・レート制限・読み取り専用・ログ記録。ローテーション手順を HANDOFF に明記 |
| **ヘッダが3セグメントで狭幅に収まらない** | iPhone でヘッダが崩れる | Phase 1 の最初に 375px 幅で確認する。収まらなければトークンで調整（ラベルの短縮より先にパディング） |
| **テナントの改称・退去で過去の記録が読めなくなる** | 帳票・実績 API の整合が崩れる | `tenant_name` を記録時点のスナップショットとして持ち、テナント行は削除せず `missing_since` を立てる |
| **入出庫の一覧が将来重くなる** | 表示が遅くなる | 既定を「3ヶ月」に絞り、在庫・年計はビューで集計。行数が万件規模になったら残高計算を SQL 側（窓関数の RPC）へ移す |

---

## 14. 実装時に触るファイル（見取り図）

| 追加 / 変更 | ファイル |
|---|---|
| 追加 | `supabase/schema.sql`（4章のテーブル・ビュー）＋同内容のマイグレーション |
| 追加 | `worker/lib/equipment.js`（社内 API）、`worker/lib/filemaker.js`（Data API クライアント。Phase 5） |
| 変更 | `worker/index.js`（`/api/equipment/*` の分岐）、`worker/lib/storage.js`（プレフィクス運用のみ。改修不要の見込み） |
| 追加 | `src/pages/Equipment.jsx`（在庫一覧）/ `EquipmentHistory.jsx` / `EquipmentItems.jsx` / `EquipmentTenants.jsx` |
| 追加 | `src/components/EquipmentTxnForm.jsx`（入出庫モーダル）/ `SignaturePad.jsx`（署名） |
| 追加 | `src/lib/equipment.js`（API クライアント） |
| 変更 | `src/App.jsx`（ルート）、`src/components/AppHeader.jsx`（3セグメント・メニュー） |
| 変更 | `src/styles/ui.css`（共通部品として足すものがあれば。個別 CSS は最後の手段） |
| 追加 | `scripts/import-equipment-csv.mjs`（初期データ取込） |
| 変更 | `docs/task-management-spec-cloudflare.md`（4-15章・5章・6章・8章）、`docs/HANDOFF.md`、この文書 |
