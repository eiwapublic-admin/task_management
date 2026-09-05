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
  contact_company  text,           -- contactを構造化: 先方（顧客）の会社名・組織名のみ。連絡帳の自動作成に使う（2026-09-01追加）
  contact_person   text,           -- contactを構造化: 先方（顧客）の担当者の氏名のみ（2026-09-01追加）
  sender_email     text,           -- 返信先アドレス（フォーム経由は本文記載のアドレスを優先）
  sender_cc        text,           -- 受信メールのCcに入っていた先方アドレス（自社アドレスは除く。カンマ区切り。
                                    -- 連絡帳の自動作成でメールCC欄の初期値に使う。2026-08-31追加）
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
alter table tasks add column if not exists contact_company text;
alter table tasks add column if not exists contact_person text;
alter table tasks add column if not exists sender_email text;
alter table tasks add column if not exists sender_cc text;
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
  -- last_fetch_at と last_run_at は役割が違うので混同しないこと（2026-09-04）。
  --   last_fetch_at … 取得クエリの窓（after:）。取得処理が最後まで完走したときだけ前進する
  --   last_run_at   … 更新間隔ゲート専用。Claude を呼ぶ前に必ず記録するため、
  --                    実行が途中で落ちても次の cron 刻みは間隔ゲートで止まる
  --                    （9/3の課金事故の再発防止。docs/ai-cost-and-alternatives.md 9章）
  ('last_fetch_at', null),
  ('last_run_at', null),
  ('fetch_stall_alert_on', ''),  -- 取得窓の凍結を通知した日（JST・YYYY-MM-DD）。1日1回に絞るため
  -- Cloudflare Workers の「1回の呼び出しあたりの外部リクエスト数」上限（2026-09-04）。
  -- 無料プラン50・Workers Paid 1000。この値を超えないよう、pipeline が重い処理
  -- （メール処理・返信検知・カレンダー）を打ち切って次の巡回へ回す。
  -- プランを上げたときはここを増やす（画面からは変更しない運用向けのキー）。
  ('subrequest_limit', '50'),
  ('reply_check_cursor', '0'),   -- 返信検知の背景スイープをどこまで見たか（task_no。一周したら0に戻る）
  ('reply_scan_days', '3'),      -- 「直近に動きのあったスレッド」を探すGmail検索の日数（返信検知の対象を絞る）
  ('subrequest_warn_on', ''),    -- サブリクエストが上限の8割に達したと通知した日（JST・YYYY-MM-DD）。1日1回に絞るため
  ('cleanup_done_on', ''),       -- 古いログ・判定記録の掃除を実行した日（JST・YYYY-MM-DD）。1日1回に絞るため
  ('calendar_id_cache', '')      -- カレンダー名→IDの解決結果のキャッシュ（{"name":..,"id":..}）。calendarListの呼び出しを省くため
on conflict (key) do nothing;

-- api_usage: Claude API の月次利用量（推定コスト表示用）
-- fax_* 列（2026-07-18 add_fax_usage_breakdown）: FAX分類（添付PDF/画像の読取を伴う）は
-- メール分類より入出力トークンが多く、将来的にFAXのみ上位モデル（Sonnet等）を使う場合に
-- 単価を分けて試算できるよう、メール/フォームとFAXの利用量を分けて集計する。
-- parking_calls（2026-08-05 add_parking_usage_breakdown）: 違反車両写真のAI読み取り
-- （recognizeVehicle）呼び出し件数。同じ考え方でメール/FAXとは別の内訳として集計する。
-- waste_calls（2026-09-03 add_waste_tracking）: 廃棄物実測集計表のスキャン読み取り
-- （recognizeWasteSheet）呼び出し件数。同じ考え方で内訳として集計する。
create table if not exists api_usage (
  month             text primary key,          -- 'YYYY-MM'（JST基準）
  input_tokens      bigint not null default 0,
  output_tokens     bigint not null default 0,
  calls             integer not null default 0,
  fax_calls         integer not null default 0,
  fax_input_tokens  bigint not null default 0,
  fax_output_tokens bigint not null default 0,
  parking_calls     integer not null default 0,
  waste_calls       integer not null default 0,
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
  p_parking_calls integer default 0,
  p_waste_calls integer default 0
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into api_usage(month, input_tokens, output_tokens, calls, fax_calls, fax_input_tokens, fax_output_tokens, parking_calls, waste_calls, updated_at)
  values (p_month, p_input, p_output, p_calls, p_fax_calls, p_fax_input, p_fax_output, p_parking_calls, p_waste_calls, now())
  on conflict (month) do update set
    input_tokens      = api_usage.input_tokens      + excluded.input_tokens,
    output_tokens     = api_usage.output_tokens     + excluded.output_tokens,
    calls             = api_usage.calls             + excluded.calls,
    fax_calls         = api_usage.fax_calls         + excluded.fax_calls,
    fax_input_tokens  = api_usage.fax_input_tokens  + excluded.fax_input_tokens,
    fax_output_tokens = api_usage.fax_output_tokens + excluded.fax_output_tokens,
    parking_calls     = api_usage.parking_calls     + excluded.parking_calls,
    waste_calls       = api_usage.waste_calls       + excluded.waste_calls,
    updated_at        = now();
$$;

-- activity_logs: 操作ログ（メール取得の実行結果、タスクのステータス変更、DBバックアップ）
create table if not exists activity_logs (
  id         uuid primary key default gen_random_uuid(),
  log_type   text not null check (log_type in ('fetch', 'status_change', 'backup')),
  actor      text not null,          -- 実行者（担当者の表示名、または「システム（自動）」）
  message    text not null,          -- 画面表示用の内容
  detail     jsonb,                  -- 取得サマリー等の生データ
  created_at timestamptz not null default now()
);

-- log_type に 'backup' を追加（マイグレーション allow_backup_activity_log_type 適用済み。2026-08-27）
alter table activity_logs drop constraint if exists activity_logs_log_type_check;
alter table activity_logs add constraint activity_logs_log_type_check check (log_type in ('fetch', 'status_change', 'backup', 'error'));

-- log_type に 'error' を追加（マイグレーション allow_error_activity_log_type 適用済み。2026-09-04）
-- 違反車両・廃棄物のAI読み取りの利用量記録が失敗しても画面から気づけなかったため。

-- processed_messages: 業務外（スパム含む）と判定したメールの記録
-- （マイグレーション add_processed_messages 適用済み。2026-09-04）
-- タスクを作らないメールは tasks に gmail_message_id が残らないため、これが無いと
-- 巡回のたびに再取得・再分類され、添付PDF/画像を毎回 Claude へ再送信してしまう。
create table if not exists processed_messages (
  gmail_message_id text primary key,
  reason           text not null default 'non_business',
  subject          text,
  judged_at        timestamptz not null default now()
);
create index if not exists processed_messages_judged_at_idx on processed_messages (judged_at);
alter table processed_messages enable row level security;
revoke all on processed_messages from anon, authenticated;

-- api_usage_daily: 1日あたりのClaude利用量（マイグレーション add_api_usage_daily 適用済み。2026-09-04）
-- サーキットブレーカー（settings.daily_api_cost_limit_usd で指定した金額に達したらAI処理を停止）
-- の判定に使う。api_usage は月次集計のため日単位の判定ができず、別に持っている。
create table if not exists api_usage_daily (
  day           date primary key,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  calls         integer not null default 0,
  updated_at    timestamptz not null default now()
);
alter table api_usage_daily enable row level security;
revoke all on api_usage_daily from anon, authenticated;

-- 加算して加算後の値を返す（呼び出し側が1件ごとに上限到達を判定できるようにするため）
create or replace function add_api_usage_daily(
  p_day    date,
  p_input  bigint  default 0,
  p_output bigint  default 0,
  p_calls  integer default 0
)
returns api_usage_daily
language plpgsql
security definer
set search_path = public
as $$
declare
  result api_usage_daily;
begin
  insert into api_usage_daily(day, input_tokens, output_tokens, calls, updated_at)
  values (p_day, p_input, p_output, p_calls, now())
  on conflict (day) do update set
    input_tokens  = api_usage_daily.input_tokens  + excluded.input_tokens,
    output_tokens = api_usage_daily.output_tokens + excluded.output_tokens,
    calls         = api_usage_daily.calls         + excluded.calls,
    updated_at    = now()
  returning * into result;
  return result;
end;
$$;
revoke all on function add_api_usage_daily(date, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function add_api_usage_daily(date, bigint, bigint, integer) to service_role;

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

revoke all on function add_api_usage(text, bigint, bigint, integer, integer, bigint, bigint, integer, integer) from public, anon, authenticated;
grant execute on function add_api_usage(text, bigint, bigint, integer, integer, bigint, bigint, integer, integer) to service_role;

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
  -- BKB（＝備後町コイズミビル）/ 小泉本社
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

-- ============================================================
-- 備品管理（蛍光ランプの入出庫・設置記録。Phase 1〜。2026-08-12〜）。
-- 現行 FileMaker「備品管理」アプリの移行。詳細は docs/equipment-plan.md 参照。
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
  -- 略称（括弧書きの補足を除いた表記。例: FLR40SW）。FileMaker連携APIの設置実績提供（6-2）で
  -- 品目表記として使う。2026-08-17追加。未指定なら備品名から自動生成する（equipment.js参照）
  short_name    text,
  product_code  text,                          -- FLR40SW/M/36（発注用情報）
  sort_order    int  not null default 99,
  warn_qty      int,                           -- 警告数量。在庫がこの値以下で「発注依頼してください」
                                               -- Web Push のしきい値も兼ねる。null なら通知しない
  -- 在庫警告を最後に通知した日時。「下回っていない→下回った」に変化した時だけ鳴らすために持つ。
  -- 在庫が warn_qty を上回ったら null に戻す（入庫で解消したら次回また鳴らせる）
  warned_at     timestamptz,
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
  -- 主キーは uuid（サロゲート）。実データに請求先コードが空のテナントがあったため NULL を許す
  id              uuid primary key default gen_random_uuid(),
  billing_code    text unique,                 -- 請求先コード（8桁）。NULL 可・あれば一意
  name            text not null,               -- 正式名称（修理伝票に出すのはこちら＋「様」）
  short_name      text,                        -- 略称（入出庫の設置先・請求データの表記はこちら）
  floor           text,                        -- 階（共用エリアは空）
  -- 退去済み。FileMaker からの全件洗い替え同期（6-3・7-1）で、送信された有効テナント一覧に
  -- 含まれなくなった行は自動でこれが true になる（論理削除。物理削除はしない）
  moved_out       boolean not null default false,
  -- ここだけ当システム側の設定値。同期で上書きしない
  default_item_id uuid references equipment_items(id),
  note            text,                        -- 検針に関する備考（同期対象）
  source          text not null default 'filemaker',  -- filemaker / manual
  synced_at       timestamptz,                 -- 最後に FileMaker から同期を受信した日時
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
  supplier    text,                            -- 調達先（入庫）※実データでは未使用
  -- テナント設置＝請求対象。この欄が入っている＝そのテナントへ請求する、という意味を持つ
  tenant_id   uuid references equipment_tenants(id),
  -- 名称・コードは記録時点のスナップショットも持つ（テナントの改称・退去後も帳票と請求履歴が崩れない）
  tenant_code text,
  tenant_name text,                            -- 正式名称（修理伝票用）
  tenant_short_name text,                      -- 略称（請求データ用。現行の表記に合わせる）
  -- 階・場所は「どこに設置したか」であって請求とは無関係。共用部設置に加え、
  -- 新規入替でも実際に使われている（8-4(2)）ため、reason では縛らない
  floor       text,                            -- 設置階（テナント設置時はテナントの階を写す）
  location    text,                            -- 設置場所（喫煙室 / 通路 / 玄関ホール …）
  staff_name  text,                            -- 担当者（複数名は「廣畑・岡田」のように1欄）
  signature_key text,                          -- 署名画像の Storage キー（テナント設置のみ）
  -- 署名を受け取った時刻。移行データは FileMaker の受領タイムスタンプをそのまま入れる。
  -- 「signed_at あり・signature_key なし」＝署名済みだが画像は現行 FileMaker 側
  signed_at   timestamptz,
  -- 移行元 FileMaker の「入出荷ID」。再取込の冪等性と、問い合わせ時の突合のために持つ
  legacy_txn_id int unique,
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
  -- 「請求先（tenant_id等）を持てるのはテナント設置のときだけ」は、あえて DB の CHECK 制約には
  -- しない。過去データに例外が実在したことに加え、この業務ルールは「新規登録の画面でテナントを
  -- 選ばせない」という入力制御が本質であり、DB が一律拒否すると移行のたびに手当てが要る。
  -- worker/lib/equipment.js の保存時バリデーション（アプリ層）でのみ強制する（docs/equipment-plan.md 4-1）
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

-- 現在庫（PostgREST から group by 相当が使えないためビューで持つ）
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

-- create or replace はビューの権限を PUBLIC に戻すことがあるため、変更のたびに revoke を必ずセットで流す
revoke all on equipment_stock, equipment_yearly_totals from anon, authenticated;

-- ============================================================
-- 雛形ファイル（業務で使う資料テンプレート。2026-08-30〜）。
-- 「登録していつでもダウンロードできる資料置き場」。日報等の業務データとは無関係の
-- プロジェクト共通情報（closed_days と同じ扱い）。ファイル本体は Storage の
-- `work-templates` バケット（非公開）、このテーブルはメタ情報のみを持つ。
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('work-templates', 'work-templates', false, 20971520, null)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create table if not exists document_templates (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,             -- 資料名称（登録時に入力）
  category          text not null,             -- 分類（登録時に入力。既存値からの選択式）
  remark            text,                      -- 備考（登録時に入力）
  -- 以下はアップロードされたファイルそのものから自動取得する（原本。Word/Excel/PDF等どれでも良い）
  original_filename text not null,             -- 物理ファイル名
  file_ext          text,                      -- 拡張子（ドット無し・小文字）
  file_size         integer,                   -- バイト数
  file_modified_at  timestamptz,               -- ファイルの最終更新日時（ブラウザのFile.lastModified）
  mime              text,
  storage_key       text not null unique,
  -- PDF版（任意。2026-08-30追加）。原本がWord/Excel等の場合に、印刷用のPDFを別ファイルとして
  -- あわせて登録できるようにする（原本と別の物理ファイル。常にPDFなので拡張子・mime列は持たない）
  pdf_storage_key         text unique,
  pdf_original_filename   text,
  pdf_file_size           integer,
  pdf_file_modified_at    timestamptz,
  -- サムネイル（任意。2026-08-31追加）。カード一覧に出す縮小画像。ユーザーが任意の画像を
  -- 指定した場合はそれを、PDF（原本 or PDF版）が登録された場合はその1ページ目をブラウザ側で
  -- 縮小したものを自動で貼り付ける。常にJPEGに揃えるので拡張子列は持たない
  thumbnail_storage_key   text unique,
  thumbnail_mime          text,
  created_by        uuid references users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists document_templates_category_idx on document_templates (category, name);

drop trigger if exists document_templates_set_updated_at on document_templates;
create trigger document_templates_set_updated_at before update on document_templates
  for each row execute function set_updated_at();

alter table document_templates enable row level security;
revoke all on document_templates from anon, authenticated;

-- ============================================================
-- 連絡帳（顧客の連絡先台帳。2026-08-31追加）
-- タスク・メールの取得実績（tasks.sender_email 等）から自動作成できるほか、手動でも登録・編集できる。
-- ============================================================

create table if not exists contacts (
  id                  uuid primary key default gen_random_uuid(),
  company_name        text not null,             -- 会社名
  business_category   text,                       -- 業務分類（自由入力。既存値からの選択式候補あり。運用しながら整理する想定）
  contact_person      text,                       -- 顧客担当者名
  staff_name          text,                       -- 当社の主担当者（settings.assignees の値を想定。自由入力可）
  company_phone       text,                       -- 会社電話番号
  mobile_phone        text,                       -- 携帯電話番号
  email_to            text,                       -- メールTO（新規メール作成時の宛先）
  email_cc            text,                       -- メールCC（連絡の際に定例で付く先。カンマ区切りで複数可）
  website_url         text,                       -- ホームページアドレス
  -- 'manual'（画面から手動登録・編集）/ 'auto'（タスク・メール実績からの自動作成。編集すると以後は手動扱いにはしない）
  created_via         text not null default 'manual',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists contacts_company_name_idx on contacts (company_name);
-- タスク・メール実績からの自動作成で同一アドレスの重複登録を防ぐ（大文字小文字は区別しない）
create unique index if not exists contacts_email_to_unique_idx on contacts (lower(email_to))
  where email_to is not null and email_to <> '';

drop trigger if exists contacts_set_updated_at on contacts;
create trigger contacts_set_updated_at before update on contacts
  for each row execute function set_updated_at();

alter table contacts enable row level security;
revoke all on contacts from anon, authenticated;

-- ============================================================
-- ビルメンテナンス管理（ビルメン。Phase 1。2026-09-02〜）
-- 現行 FileMaker「BKB-Mgt / 作業管理」の移行。詳細は docs/bilmen-plan.md 参照。
-- 建物は「備後町コイズミビル」1棟で確定のため building 列は持たない（同 13-4）。
-- 既存方針どおり anon/authenticated からは一切触れない（Worker の service role 経由のみ）。
-- ============================================================

-- ---------- 作業マスタ（bilmen-plan 2-6・2-7） ----------
create table if not exists bilmen_masters (
  id            uuid primary key default gen_random_uuid(),
  -- FileMaker の「作業マスタID」（1, 2, 3, 5, 14, 21, 28…）。移行の突合キーなので必ず保持する。
  -- 欠番は正常（無効化・統合された作業がありうる）
  master_no     int  not null unique,
  title         text not null,                  -- 作業名（作業タイトル）
  title_note    text,                           -- 作業の補足（連絡票で作業名の下に青文字で出る）
  content       text,                           -- 作業内容（予定詳細の「補足」）
  notice        text,                           -- 注意事項（告知）。連絡票の「(4) 留意事項」
  place         text,                           -- 作業場所。連絡票の「(2) 場所」
  enter_room    boolean not null default false, -- 入室作業（日程表の「入室あり*」に ✓）
  notify        boolean not null default false, -- 報知対象（掲示・メールに載せるか。3-4）
  jurisdiction  text,                           -- 管轄（'栄和' | '小泉産業'）
  vendor_code   text,                           -- 担当会社コード（K-004 等）
  vendor_name   text,                           -- 担当会社名（セコム / 明和ビル管理 …）
  worker_name   text,                           -- 実施業者名（担当会社の下請け等）
  prep_note     text,                           -- 管理側作業・準備（一覧の青■ラベル）
  plan_start    time,                           -- 既定の予定開始時刻
  plan_end      time,                           -- 既定の予定終了時刻
  -- 定例実施月。{1,3,5,7,9,11}。空配列＝自動作成の対象外（随時作業）
  months        int[] not null default '{}',
  day_pattern   text,                           -- 実施日パターン（'月半ば' 等。フリーテキスト）
  -- 不規則周期のメモ（'2019,2022,2025,2028' / '3年に1回（2025年〜）'）。機械判定はしない
  cycle_pattern text,
  memo          text,                           -- 管理メモ／注意事項（社内専用）
  remark        text,                           -- 備考
  sort_order    int  not null default 999,      -- 表示順（10, 20, 30…。再採番機能あり）
  disabled      boolean not null default false, -- 無効（選択肢に出さない。過去の予定は残す）
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists bilmen_masters_order_idx
  on bilmen_masters (disabled, sort_order, master_no);

drop trigger if exists bilmen_masters_set_updated_at on bilmen_masters;
create trigger bilmen_masters_set_updated_at before update on bilmen_masters
  for each row execute function set_updated_at();

-- ---------- メンテナンス予定・実績（bilmen-plan 2-1・2-2） ----------
create table if not exists bilmen_schedules (
  id            uuid primary key default gen_random_uuid(),
  -- 作業ID（W260901-27）。カレンダー説明欄にも出す識別子。移行時は現行の値をそのまま継承し、
  -- 新規分も現行どおり手入力（自動採番はしない。13-5）。
  -- ★nullable にしてある: 予定の自動作成は複数行を一括生成するため、その時点では
  --   まだ人が作業IDを入力していない。unique は NULL を重複と見なさないので
  --   「未入力の行は複数あってよい／入力された値は一意」をこの1本で表現できる
  work_no       text unique,
  master_id     uuid references bilmen_masters(id) on delete set null,
  -- 対象月 'YYYY-MM'。予定日が未定でも「その月の予定」として一覧・帳票に並べるため必須
  target_month  text not null,
  plan_date     date,                            -- 予定日付（自動作成直後は null＝日付未定）
  plan_start    time,
  plan_end      time,

  -- ↓ マスタからの複写（3-2）。以後マスタを直しても過去の予定は変わらない
  title         text not null,
  title_note    text,
  content       text,
  notice        text,
  place         text,
  enter_room    boolean not null default false,
  notify        boolean not null default false,
  jurisdiction  text,
  vendor_code   text,
  vendor_name   text,
  worker_name   text,
  prep_note     text,
  remark        text,

  memo          text,                            -- 管理メモ（'9/3から9/4に変更されました'）

  -- ↓ 実績
  actual_date   date,
  actual_start  time,
  actual_end    time,
  actual_note   text,                            -- 作業実績報告事項
  report_confirmed_on date,                      -- 報告書確認日付
  canceled      boolean not null default false,  -- 中止
  cancel_reason text,

  -- ↓ Google カレンダー連携（Phase 3。7-2）
  google_event_id  text,
  google_synced_at timestamptz,

  sort_order    int  not null default 999,       -- 同一日内の並び
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists bilmen_schedules_month_idx
  on bilmen_schedules (target_month desc, plan_date, sort_order);
create index if not exists bilmen_schedules_date_idx
  on bilmen_schedules (plan_date);

drop trigger if exists bilmen_schedules_set_updated_at on bilmen_schedules;
create trigger bilmen_schedules_set_updated_at before update on bilmen_schedules
  for each row execute function set_updated_at();

alter table bilmen_masters   enable row level security;
alter table bilmen_schedules enable row level security;
revoke all on bilmen_masters   from anon, authenticated;
revoke all on bilmen_schedules from anon, authenticated;

-- ============================================================
-- 廃棄物実測値管理（BKBビル・一般廃棄物。2026-09-03〜。docs/waste-plan.md）
-- ============================================================

create table if not exists waste_scans (
  id           uuid primary key default gen_random_uuid(),
  target_month text not null,             -- 'YYYY-MM'（読み取り対象の月）
  storage_key  text not null,             -- アップロードした画像（report-photos バケット）
  mime         text not null default 'image/jpeg',
  status       text not null default 'pending' check (status in ('pending', 'reviewed')),
  raw_result   jsonb,                     -- Claude の生の読み取り結果（監査用）
  reviewed_by  text,
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists waste_records (
  id           uuid primary key default gen_random_uuid(),
  record_date  date not null,
  floor        text not null,             -- '1'〜'7'
  weight_kg    numeric(6,2) not null,
  source       text not null default 'manual' check (source in ('manual', 'ocr')),
  is_confirmed boolean not null default true,  -- OCR取込直後だけ false。手入力は常に true
  scan_id      uuid references waste_scans(id) on delete set null,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (record_date, floor)
);

create index if not exists idx_waste_records_date on waste_records (record_date);
create index if not exists idx_waste_scans_month on waste_scans (target_month);

drop trigger if exists trg_waste_records_updated_at on waste_records;
create trigger trg_waste_records_updated_at
  before update on waste_records
  for each row execute function set_updated_at();

alter table waste_records enable row level security;
alter table waste_scans enable row level security;
revoke all on waste_records from anon, authenticated;
revoke all on waste_scans from anon, authenticated;
