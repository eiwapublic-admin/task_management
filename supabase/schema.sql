-- タスク管理システム DBスキーマ
-- Supabase SQL Editor で実行してください

create extension if not exists pgcrypto;

-- tasks.task_no（人が扱いやすい短い連番）の採番用。テーブル定義より先に作る必要がある。
create sequence if not exists tasks_task_no_seq;

-- tasks: メインのタスク情報
create table if not exists tasks (
  id               uuid primary key default gen_random_uuid(),
  -- 人がタスクを口頭・文面で特定しやすくするための短い連番（画面上は「T-123」と表示）。
  -- 主キーのUUIDは長く会話や依頼文で扱いにくいため別途持たせる（2026-07-29）。
  task_no          bigint not null unique default nextval('tasks_task_no_seq'),
  -- 一意性はスレッドではなくメッセージ（元メール）単位。FAXは同一件名・同一送信元で
  -- Gmailが複数を1スレッドに束ねるため、gmail_thread_id を unique にすると2通目以降の
  -- FAXが取り込めない（insertが弾かれる）。gmail_message_id は全チャネルで一意なので、
  -- 真の重複（同一メールから複数タスク）は防ぎつつ1スレッド複数FAXを許容できる（2026-07-24）。
  gmail_thread_id  text not null,
  gmail_message_id text not null unique,
  title            text not null,
  assignee         text not null,
  status           text not null default '未処理'
                   check (status in ('未処理', '返信済み', '対応中', '完了')),
  due_date         date,
  sender           text not null,
  subject          text not null,
  body_preview     text,
  classification_note text,        -- Claude が付けた判定理由（振り分けルール調整の参考用）
  sender_display   text,           -- 送信元の会社名・氏名（Claude が件名/本文から抽出）
  contact          text,           -- 先方担当者の宛名（会社・氏名＋様。返信メール冒頭に使う。Claude 抽出 or sender_display+様）
  sender_email     text,           -- 返信先アドレス（フォーム経由は本文記載のアドレスを優先）
  -- スパム（迷惑メール・営業FAX等）と人が判定した目印。カードの「スパム」ボタンで
  -- true にすると同時に完了＋アーカイブへ移る。アーカイブ画面で解除・復帰できる（2026-07-30）。
  is_spam          boolean not null default false,
  remarks          text,           -- 留意事項（担当者が詳細画面で自由入力するメモ）
  last_reply_message_id text,       -- 最後に取り込んだ返信メールの Gmail message id（返信検知の冪等化・返信済みへの再返信で本文を上書きするため）
  source           text not null default 'email',  -- 取得元: 'email'（Gmail） / 'calendar'（Googleカレンダー） / 'manual'（手動登録）
  channel          text,           -- カード/詳細画面のアイコン表示用の経路種別: 'email'/'form'/'fax'/'calendar'/'manual'。
                                    -- source='email' の内訳（通常メール/問い合わせフォーム/FAX転送）を区別するために追加。
                                    -- source の値（返信検知等のロジックで使用）とは独立。null の既存タスクは source から表示用に補完する
  completed_at     timestamptz,    -- ステータスが「完了」になった日時（アーカイブ移行の起点。完了以外に戻すと null に戻す）
  archived_at      timestamptz,    -- アーカイブに移行した日時（NULL でない = アーカイブ済み。カンバンから除外しアーカイブ画面で参照）
  received_at      timestamptz not null,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- 既存テーブルへの後方互換の追加（Phase 2 で導入）
alter table tasks add column if not exists classification_note text;
alter table tasks add column if not exists sender_display text;
alter table tasks add column if not exists contact text;
alter table tasks add column if not exists sender_email text;
alter table tasks add column if not exists remarks text;
alter table tasks add column if not exists last_reply_message_id text;
alter table tasks add column if not exists source text not null default 'email';
alter table tasks add column if not exists channel text;
alter table tasks add column if not exists completed_at timestamptz;
alter table tasks add column if not exists archived_at timestamptz;
alter table tasks add column if not exists is_spam boolean not null default false;

create index if not exists idx_tasks_archived_at on tasks (archived_at);
-- スパムだけを絞り込む用途（アーカイブ画面）。true の行だけの部分インデックス
create index if not exists idx_tasks_is_spam on tasks (is_spam) where is_spam;

create index if not exists idx_tasks_status on tasks (status);
create index if not exists idx_tasks_assignee on tasks (assignee);

-- settings: システム設定
create table if not exists settings (
  key   text primary key,
  value text
);

insert into settings (key, value) values
  ('fetch_interval_minutes', '30'),
  ('active_hours_start', '8'),      -- 稼働開始時刻（JST・時）
  ('active_hours_end', '18'),       -- 稼働終了時刻（JST・時、この時刻以降は停止）
  ('assignees', '["橋口","西川","岡田"]'),
  ('business_keywords', ''),
  ('org_context', ''),
  ('shared_gmail', 'eiwa.public@gmail.com'),
  ('company_domains', 'eiwa-up.jp'),  -- 自社ドメイン（カンマ区切り）。このドメイン発のメールは「自社からの返信」とみなす
  ('calendar_name', '栄和共通'),      -- 取得対象の Google カレンダー名 または カレンダーID（@を含む場合はID直接指定）
  ('archive_after_days', '30'),  -- 「完了」からこの日数を超えたタスクをアーカイブに移行（0 で無効）
  ('api_credit_alert', ''),      -- クレジット不足アラート（pipeline が設定/解除）
  ('last_fetch_at', null)
on conflict (key) do nothing;

-- api_usage: Claude API の月次利用量（推定コスト表示用）
-- fax_* 列（2026-07-18 add_fax_usage_breakdown）: FAX分類（添付PDF/画像の読取を伴う）は
-- メール分類より入出力トークンが多く、将来的にFAXのみ上位モデル（Sonnet等）を使う場合に
-- 単価を分けて試算できるよう、メール/フォームとFAXの利用量を分けて集計する。
-- parking_calls（2026-08-05 add_parking_usage_breakdown）: 違反車両写真のAI読み取り
-- （recognizeVehicle）呼び出し件数。同じ考え方でメール/FAXとは別の内訳として集計する。
create table if not exists api_usage (
  month             text primary key,          -- 'YYYY-MM'（JST基準）
  input_tokens      bigint not null default 0,
  output_tokens     bigint not null default 0,
  calls             integer not null default 0,
  fax_calls         integer not null default 0,
  fax_input_tokens  bigint not null default 0,
  fax_output_tokens bigint not null default 0,
  parking_calls     integer not null default 0,
  updated_at        timestamptz not null default now()
);

-- 月次利用量を原子的に加算するヘルパー（service role から rpc で呼ぶ）
create or replace function add_api_usage(
  p_month text,
  p_input bigint,
  p_output bigint,
  p_calls integer,
  p_fax_calls integer default 0,
  p_fax_input bigint default 0,
  p_fax_output bigint default 0,
  p_parking_calls integer default 0
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into api_usage(month, input_tokens, output_tokens, calls, fax_calls, fax_input_tokens, fax_output_tokens, parking_calls, updated_at)
  values (p_month, p_input, p_output, p_calls, p_fax_calls, p_fax_input, p_fax_output, p_parking_calls, now())
  on conflict (month) do update set
    input_tokens      = api_usage.input_tokens      + excluded.input_tokens,
    output_tokens     = api_usage.output_tokens     + excluded.output_tokens,
    calls             = api_usage.calls             + excluded.calls,
    fax_calls         = api_usage.fax_calls         + excluded.fax_calls,
    fax_input_tokens  = api_usage.fax_input_tokens  + excluded.fax_input_tokens,
    fax_output_tokens = api_usage.fax_output_tokens + excluded.fax_output_tokens,
    parking_calls     = api_usage.parking_calls     + excluded.parking_calls,
    updated_at        = now();
$$;

-- activity_logs: 操作ログ（メール取得の実行結果、タスクのステータス変更）
create table if not exists activity_logs (
  id         uuid primary key default gen_random_uuid(),
  log_type   text not null check (log_type in ('fetch', 'status_change')),
  actor      text not null,          -- 実行者（担当者の表示名、または「システム（自動）」）
  message    text not null,          -- 画面表示用の内容
  detail     jsonb,                  -- 取得サマリー等の生データ
  created_at timestamptz not null default now()
);

create index if not exists idx_activity_logs_created_at on activity_logs (created_at desc);

-- users: 認証用（カスタム認証。パスワードはbcryptハッシュ）
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null unique,
  password_hash text not null,
  display_name  text not null,
  -- JWT失効用のバージョン番号。ログイン時に発行するJWTへ tv として埋め込み、
  -- 以後のリクエストでこの値と突合する。パスワード変更・退職・トークン漏洩時に
  -- インクリメントすると、有効期限（30日）を待たずに当該ユーザーの全トークンを即時失効できる。
  token_version integer not null default 0,
  created_at    timestamptz default now()
);

alter table users add column if not exists token_version integer not null default 0;

-- push_subscriptions: Web Push通知の購読情報（ブラウザ/端末ごと）。
-- 新しいタスクが自動登録された際に、購読中の全端末へ通知を送るために使う
-- （worker/lib/push.js）。endpoint はブラウザのインストールごとに一意。
create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_push_subscriptions_user_id on push_subscriptions (user_id);

-- updated_at 自動更新
create or replace function set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tasks_updated_at on tasks;
create trigger trg_tasks_updated_at
  before update on tasks
  for each row execute function set_updated_at();

-- Row Level Security
-- フロントエンドは Supabase を直接読み書きしない（anon key による匿名アクセスは全廃）。
-- tasks/settings/activity_logs/api_usage への読み書きはすべて Worker が
-- service role 経由・JWT 認証必須の /api/* を通して行う。
-- anon(publishable) キーは公開値であり、これに読み書き権限を与えると
-- 未認証の第三者が顧客データを読める／改ざんできてしまうため、
-- RLS は有効のままポリシーを一切持たせず、GRANT もすべて剥奪する。

alter table tasks enable row level security;
alter table settings enable row level security;
alter table users enable row level security;
alter table api_usage enable row level security;
alter table activity_logs enable row level security;
alter table push_subscriptions enable row level security;

-- 過去に存在した匿名向けの緩いポリシーを削除（RLS 有効・ポリシー無し = anon は一切アクセス不可）
drop policy if exists "tasks_select_all" on tasks;
drop policy if exists "tasks_update_status" on tasks;
drop policy if exists "settings_select_all" on settings;
drop policy if exists "api_usage_select_all" on api_usage;
drop policy if exists "activity_logs_select_all" on activity_logs;
drop policy if exists "activity_logs_insert_all" on activity_logs;

revoke all on tasks              from anon, authenticated;
revoke all on settings           from anon, authenticated;
revoke all on api_usage          from anon, authenticated;
revoke all on activity_logs      from anon, authenticated;
revoke all on push_subscriptions from anon, authenticated;

revoke all on function add_api_usage(text, bigint, bigint, integer, integer, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function add_api_usage(text, bigint, bigint, integer, integer, bigint, bigint, integer) to service_role;

-- users テーブルには anon 向けポリシーを一切作成しない（service role key のみが操作可能。従来どおり）

-- ============================================================
-- 日報機能（2026-08-04〜。Phase 1: 権限ロール + 日報ヘッダ/明細 + 定型文マスタ）
-- 詳細は docs/daily-report-plan.md を参照
-- ============================================================

-- 権限ロール。staff=従来どおり全機能 / owner=日報の閲覧のみ（書き込み不可） / admin=将来の分離用
-- 既存ユーザーは既定値 staff になるため、この追加による挙動の変化はない
alter table users add column if not exists role text not null default 'staff';
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('staff', 'owner', 'admin'));

-- 日報ヘッダ。1日1件（BKB＝備後町コイズミビルと小泉本社を1件にまとめる）
create table if not exists daily_reports (
  id          uuid primary key default gen_random_uuid(),
  report_date date not null unique,
  worker_am   text,
  worker_pm   text,
  work_start  time,
  work_end    time,
  created_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists daily_reports_date_idx on daily_reports (report_date desc);

-- 作業記録の明細（現行の「特記事項」。時刻＋内容）
create table if not exists report_entries (
  id             uuid primary key default gen_random_uuid(),
  report_id      uuid not null references daily_reports(id) on delete cascade,
  entry_time     time,
  content        text not null default '',
  -- タスク管理から転記した場合の元タスク。タスクが消えても明細自体は残す
  source_task_id uuid references tasks(id) on delete set null,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists report_entries_report_idx on report_entries (report_id, sort_order, entry_time);

-- 定型文マスタ（ルーチン業務の文言。現行の「特記事項設定」に相当）
create table if not exists routine_templates (
  id         uuid primary key default gen_random_uuid(),
  label      text not null,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists routine_templates_order_idx on routine_templates (is_active, sort_order);

drop trigger if exists daily_reports_set_updated_at on daily_reports;
create trigger daily_reports_set_updated_at before update on daily_reports
  for each row execute function set_updated_at();
drop trigger if exists report_entries_set_updated_at on report_entries;
create trigger report_entries_set_updated_at before update on report_entries
  for each row execute function set_updated_at();

-- 既存方針どおり anon/authenticated からは一切アクセス不可（service role のみ）
alter table daily_reports     enable row level security;
alter table report_entries    enable row level security;
alter table routine_templates enable row level security;
revoke all on daily_reports     from anon, authenticated;
revoke all on report_entries    from anon, authenticated;
revoke all on routine_templates from anon, authenticated;

-- 日報の写真（Phase 2。2026-08-04）。実体は Supabase Storage の非公開バケット
-- `report-photos` に置き、DB にはメタ情報のみ持つ。取得は必ず Worker(service role)経由。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-photos', 'report-photos', false, 10485760,
        array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create table if not exists report_photos (
  id          uuid primary key default gen_random_uuid(),
  report_id   uuid not null references daily_reports(id) on delete cascade,
  -- 用途ごとに保存解像度を変えるため区別する（work=720px / parking=1280px）
  category    text not null default 'work' check (category in ('work','parking','chlorine')),
  -- 保管先のオブジェクトキー。保管先を差し替えられるようURLではなくキーだけを持つ
  storage_key text not null unique,
  -- 一覧に写真が並ぶ用途（不正駐車）だけサムネイルを持つ。無ければ本体で代替する
  thumb_key   text unique,
  filename    text,
  mime        text,
  size        integer,
  width       integer,
  height      integer,
  comment     text,
  taken_at    timestamptz,
  sort_order  integer not null default 0,
  created_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists report_photos_report_idx on report_photos (report_id, category, sort_order);

drop trigger if exists report_photos_set_updated_at on report_photos;
create trigger report_photos_set_updated_at before update on report_photos
  for each row execute function set_updated_at();

alter table report_photos enable row level security;
revoke all on report_photos from anon, authenticated;

-- 自主検査表（日常）。Phase 3。2026-08-04。紙の様式の置き換え。
-- 紙の記入ルール「不備が有る場合は項目に×とし、良好の場合は確認箇所一斉に○とすること」に
-- 合わせ、通常は all_clear=true だけで済み、不備のある項目だけ items に持つ。
create table if not exists fire_inspections (
  id           uuid primary key default gen_random_uuid(),
  building     text not null,           -- BKB（＝備後町コイズミビル）/ 小泉本社
  inspected_on date not null,
  inspector    text,
  all_clear    boolean not null default false,  -- 「点検箇所一斉」に○＝全項目良好
  -- 不備のある項目だけを持つ {"防火区画":"ng"}。ok=良 / ng=不良 / fixed=即時改修（紙の ○×◎）
  items        jsonb not null default '{}'::jsonb,
  note         text,
  -- 6月・12月の定期点検結果。ok=支障無し / ng=支障有り
  periodic_result text check (periodic_result in ('ok','ng')),
  confirmed_by text,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint fire_inspections_building_date_key unique (building, inspected_on)
);
create index if not exists fire_inspections_date_idx on fire_inspections (inspected_on desc, building);

drop trigger if exists fire_inspections_set_updated_at on fire_inspections;
create trigger fire_inspections_set_updated_at before update on fire_inspections
  for each row execute function set_updated_at();

alter table fire_inspections enable row level security;
revoke all on fire_inspections from anon, authenticated;

-- 休館日（2026-08-05に fire_inspections.closed として追加 → 2026-08-07に独立テーブルへ移行）。
-- 自主検査表専用ではなく日報一覧とも共有する「プロジェクト共通」の情報にするため、
-- 建物・点検の有無に関わらず日付単位で持つ独立したテーブルに切り出した。
create table if not exists closed_days (
  closed_on  date primary key,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
alter table closed_days enable row level security;
revoke all on closed_days from anon, authenticated;

-- ============================================================
-- 不正駐車（Phase 4。2026-08-05〜）。日報詳細から写真と同様の流れで登録するが、
-- 一覧は日を跨って横断的に見られるよう daily_reports とは独立したテーブルにする。
-- ============================================================
create table if not exists parking_violations (
  id            uuid primary key default gen_random_uuid(),
  report_id     uuid not null references daily_reports(id) on delete cascade,
  checked_at    timestamptz not null default now(),
  -- ナンバープレートの地名・番号。この2列で過去履歴・累計回数を名寄せする
  plate_region  text,
  plate_number  text,
  maker         text,
  model         text,
  owner_company text,
  -- unrecorded=無断駐車 / false_entry=虚偽記入 / long_stay=長時間駐車 / after_hours=時間外 / other=その他
  violations    text[] not null default '{}'::text[],
  note          text,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists parking_violations_plate_idx on parking_violations (plate_region, plate_number);
create index if not exists parking_violations_report_idx on parking_violations (report_id);
create index if not exists parking_violations_checked_idx on parking_violations (checked_at desc);

drop trigger if exists parking_violations_set_updated_at on parking_violations;
create trigger parking_violations_set_updated_at before update on parking_violations
  for each row execute function set_updated_at();

alter table parking_violations enable row level security;
revoke all on parking_violations from anon, authenticated;

-- 写真をどの違反車両レコードの分か紐付ける（category='parking' のときのみ使う）
alter table report_photos add column if not exists parking_id uuid references parking_violations(id) on delete cascade;
create index if not exists report_photos_parking_idx on report_photos (parking_id);

-- ============================================================
-- 残留塩素等検査（Phase 5。2026-08-10）。週1回・建物別に残留塩素濃度と
-- 色/濁り/臭気/味を記録し、年単位・建物別に「残留塩素等検査実施記録表」として
-- PDF出力する（小泉産業様への提出物）。日を跨って一覧するため独立した行として
-- 持つが、写真（report_photos）が日報に属する設計のため report_id で当日の
-- 日報に紐付ける（日報が無い日は API 側で作成してから紐付ける）。
-- ============================================================
create table if not exists chlorine_tests (
  id            uuid primary key default gen_random_uuid(),
  report_id     uuid not null references daily_reports(id) on delete cascade,
  -- BKB（＝備後町コイズミビル）/ スイングビル / 小泉本社
  building      text not null,
  -- 採水場所（1F給湯室 等）
  location      text,
  tested_at     timestamptz not null default now(),
  -- 残留塩素濃度（mg/L）。水道水質基準は遊離残留塩素 0.1mg/L 以上
  concentration numeric(4,2),
  -- 色・濁り・臭気・味の判定。true=OK / false=NG / null=未選択
  color_ok      boolean,
  turbidity_ok  boolean,
  odor_ok       boolean,
  taste_ok      boolean,
  inspector     text,
  note          text,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists chlorine_tests_tested_idx on chlorine_tests (tested_at desc);
create index if not exists chlorine_tests_building_idx on chlorine_tests (building, tested_at desc);
create index if not exists chlorine_tests_report_idx on chlorine_tests (report_id);

drop trigger if exists chlorine_tests_set_updated_at on chlorine_tests;
create trigger chlorine_tests_set_updated_at before update on chlorine_tests
  for each row execute function set_updated_at();

alter table chlorine_tests enable row level security;
revoke all on chlorine_tests from anon, authenticated;

-- 検査薬の色変化の写真をどの検査レコードの分か紐付ける（category='chlorine' のときのみ使う）
alter table report_photos add column if not exists chlorine_id uuid references chlorine_tests(id) on delete cascade;
create index if not exists report_photos_chlorine_idx on report_photos (chlorine_id);
