-- タスク管理システム DBスキーマ
-- Supabase SQL Editor で実行してください

create extension if not exists pgcrypto;

-- tasks: メインのタスク情報
create table if not exists tasks (
  id               uuid primary key default gen_random_uuid(),
  gmail_thread_id  text not null unique,
  gmail_message_id text not null,
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
  sender_email     text,           -- 返信先アドレス（フォーム経由は本文記載のアドレスを優先）
  source           text not null default 'email',  -- 取得元: 'email'（Gmail） / 'calendar'（Googleカレンダー）
  received_at      timestamptz not null,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- 既存テーブルへの後方互換の追加（Phase 2 で導入）
alter table tasks add column if not exists classification_note text;
alter table tasks add column if not exists sender_display text;
alter table tasks add column if not exists sender_email text;
alter table tasks add column if not exists source text not null default 'email';

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
  ('calendar_name', '栄和共通'),      -- 取得対象の Google カレンダー名（当日イベントをタスク化）
  ('api_credit_alert', ''),      -- クレジット不足アラート（pipeline が設定/解除）
  ('last_fetch_at', null)
on conflict (key) do nothing;

-- api_usage: Claude API の月次利用量（推定コスト表示用）
create table if not exists api_usage (
  month         text primary key,          -- 'YYYY-MM'（JST基準）
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  calls         integer not null default 0,
  updated_at    timestamptz not null default now()
);

-- 月次利用量を原子的に加算するヘルパー（service role から rpc で呼ぶ）
create or replace function add_api_usage(p_month text, p_input bigint, p_output bigint, p_calls integer)
returns void
language sql
security definer
set search_path = public
as $$
  insert into api_usage(month, input_tokens, output_tokens, calls, updated_at)
  values (p_month, p_input, p_output, p_calls, now())
  on conflict (month) do update set
    input_tokens  = api_usage.input_tokens  + excluded.input_tokens,
    output_tokens = api_usage.output_tokens + excluded.output_tokens,
    calls         = api_usage.calls         + excluded.calls,
    updated_at    = now();
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
  created_at    timestamptz default now()
);

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
-- フロントエンドは anon key のみを使用するため、
-- tasks/settings は読み取りを許可し、書き込みは service role (Netlify Functions) 経由に限定する。
-- users テーブルはフロントエンドから一切アクセスさせない（service role のみ）。

alter table tasks enable row level security;
alter table settings enable row level security;
alter table users enable row level security;
alter table api_usage enable row level security;
alter table activity_logs enable row level security;

drop policy if exists "tasks_select_all" on tasks;
create policy "tasks_select_all" on tasks
  for select using (true);

-- フロントエンド（anon key）はカンバンのステータス変更のみ行える。
-- RLSの with check だけでは「どの列を更新できるか」を制限できないため、
-- 列レベルのGRANTで status 列のみ更新可能にする。
-- INSERT / DELETE / その他の列の更新は service role（Netlify Functions）経由に限定される。
drop policy if exists "tasks_update_status" on tasks;
create policy "tasks_update_status" on tasks
  for update using (true) with check (true);

revoke insert, update, delete on tasks from anon, authenticated;
grant update (status) on tasks to anon, authenticated;

drop policy if exists "settings_select_all" on settings;
create policy "settings_select_all" on settings
  for select using (true);

-- api_usage はフロントエンドから参照のみ許可。書き込みは service role（rpc）経由。
drop policy if exists "api_usage_select_all" on api_usage;
create policy "api_usage_select_all" on api_usage
  for select using (true);

grant select on api_usage to anon, authenticated;
revoke insert, update, delete on api_usage from anon, authenticated;

-- activity_logs はフロントエンドから参照と追記のみ許可（改変・削除は service role のみ）。
drop policy if exists "activity_logs_select_all" on activity_logs;
create policy "activity_logs_select_all" on activity_logs
  for select using (true);

drop policy if exists "activity_logs_insert_all" on activity_logs;
create policy "activity_logs_insert_all" on activity_logs
  for insert with check (true);

grant select, insert on activity_logs to anon, authenticated;
revoke update, delete on activity_logs from anon, authenticated;

revoke all on function add_api_usage(text, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function add_api_usage(text, bigint, bigint, integer) to service_role;

-- users テーブルには anon 向けポリシーを一切作成しない（service role key のみが操作可能）
