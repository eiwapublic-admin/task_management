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
  received_at      timestamptz not null,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- 既存テーブルへの後方互換の追加（Phase 2 で導入）
alter table tasks add column if not exists classification_note text;

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
  ('last_fetch_at', null)
on conflict (key) do nothing;

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

-- users テーブルには anon 向けポリシーを一切作成しない（service role key のみが操作可能）
