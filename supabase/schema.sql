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
  contact          text,           -- 発信元の会社・担当者名（問い合わせフォームは本文から抽出）
  classification_note text,        -- Claude が付けた判定理由（振り分けルール調整の参考用）
  received_at      timestamptz not null,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- 既存テーブルへの後方互換の追加（Phase 2 で導入）
alter table tasks add column if not exists classification_note text;
alter table tasks add column if not exists contact text;

create index if not exists idx_tasks_status on tasks (status);
create index if not exists idx_tasks_assignee on tasks (assignee);

-- settings: システム設定
create table if not exists settings (
  key   text primary key,
  value text
);

insert into settings (key, value) values
  ('fetch_interval_minutes', '30'),
  ('assignees', '["橋口","西川","岡田"]'),
  ('business_keywords', ''),
  ('org_context', ''),
  ('shared_gmail', 'eiwa.public@gmail.com'),
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

revoke all on function add_api_usage(text, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function add_api_usage(text, bigint, bigint, integer) to service_role;

-- users テーブルには anon 向けポリシーを一切作成しない（service role key のみが操作可能）
