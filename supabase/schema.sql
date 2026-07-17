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
  contact          text,           -- 先方担当者の宛名（会社・氏名＋様。返信メール冒頭に使う。Claude 抽出 or sender_display+様）
  sender_email     text,           -- 返信先アドレス（フォーム経由は本文記載のアドレスを優先）
  remarks          text,           -- 留意事項（担当者が詳細画面で自由入力するメモ）
  last_reply_message_id text,       -- 最後に取り込んだ返信メールの Gmail message id（返信検知の冪等化・返信済みへの再返信で本文を上書きするため）
  source           text not null default 'email',  -- 取得元: 'email'（Gmail） / 'calendar'（Googleカレンダー） / 'manual'（手動登録）
  channel          text,           -- カード/詳細画面のアイコン表示用の経路種別: 'email'/'form'/'fax'/'calendar'/'manual'。
                                    -- source='email' の内訳（通常メール/問い合わせフォーム/FAX転送）を区別するために追加。
                                    -- source の値（返信検知等のロジックで使用）とは独立。null の既存タスクは source から表示用に補完する
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
  -- JWT失効用のバージョン番号。ログイン時に発行するJWTへ tv として埋め込み、
  -- 以後のリクエストでこの値と突合する。パスワード変更・退職・トークン漏洩時に
  -- インクリメントすると、有効期限（30日）を待たずに当該ユーザーの全トークンを即時失効できる。
  token_version integer not null default 0,
  created_at    timestamptz default now()
);

alter table users add column if not exists token_version integer not null default 0;

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

-- 過去に存在した匿名向けの緩いポリシーを削除（RLS 有効・ポリシー無し = anon は一切アクセス不可）
drop policy if exists "tasks_select_all" on tasks;
drop policy if exists "tasks_update_status" on tasks;
drop policy if exists "settings_select_all" on settings;
drop policy if exists "api_usage_select_all" on api_usage;
drop policy if exists "activity_logs_select_all" on activity_logs;
drop policy if exists "activity_logs_insert_all" on activity_logs;

revoke all on tasks         from anon, authenticated;
revoke all on settings      from anon, authenticated;
revoke all on api_usage     from anon, authenticated;
revoke all on activity_logs from anon, authenticated;

revoke all on function add_api_usage(text, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function add_api_usage(text, bigint, bigint, integer) to service_role;

-- users テーブルには anon 向けポリシーを一切作成しない（service role key のみが操作可能。従来どおり）
