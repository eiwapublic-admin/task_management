-- 勤怠管理（eWorks）のテーブル（docs/eworks-plan.md 9章）
-- Supabase SQL Editor（またはマイグレーション）で実行する。何度実行しても同じ結果になるように書く。
-- テーブルは works_ 接頭辞。読み書きは eworks Worker（service_role）経由だけ（anon/authenticated には権限を付けない）。
--
-- Phase 1（2026-11-18）: スタッフ・出退勤パターン・現場・勤務体系・設定・招待

-- ---------------------------------------------------------------------------
-- 利用者の役割: 現場スタッフ（field_staff）を追加し、eWorks 管理者の印を 1 列足す
--   field_staff はタスク管理（既存アプリ）にはログインできない（worker/index.js で拒否）
-- ---------------------------------------------------------------------------
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('staff', 'owner', 'admin', 'equipment_out_staff', 'field_staff'));
alter table users add column if not exists works_admin boolean not null default false;

-- ---------------------------------------------------------------------------
-- 出退勤パターン（現行: 出退勤パターン_勤怠）
-- ---------------------------------------------------------------------------
create table if not exists works_shift_patterns (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,          -- タイプ名（例: 日勤パート02）
  start_time  time not null,                 -- 出勤予定時刻
  end_time    time not null,                 -- 退勤予定時刻
  active      boolean not null default true, -- 停止中のパターンは false（新しい予定には使わない）
  legacy_id   text,                          -- FileMaker の ID（移行の突合用）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 現場（現行: 作業マスタ）。位置と QR の合言葉（ハッシュ）は Phase 3 で使う
-- ---------------------------------------------------------------------------
create table if not exists works_sites (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,        -- 作業コード（例: 90001）
  name           text not null,               -- 作業名称
  detail         text,                        -- 作業詳細（例: 日常清掃）
  address        text,                        -- 住所（決定事項 11 の例外: QR 持ち出し対策で持つ）
  lat            double precision,
  lng            double precision,
  radius_m       integer not null default 300, -- 位置の許容距離
  qr_secret_hash text,                         -- QR の合言葉のハッシュ（Phase 3）
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- スタッフ（現行: eSales 担当者マスタ＋勤怠システムの従業員。決定事項 13・14）
--   携帯電話・IC カード番号・給与関連は持たない
-- ---------------------------------------------------------------------------
create table if not exists works_staff (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,     -- 担当者コード（現行のまま）
  name               text not null,
  kana               text,
  dept               text,                     -- 所属コード
  hired_on           date,                     -- 入社日（有休の付与に使う）
  status             text not null default 'active' check (status in ('active', 'leave', 'retired')),
  default_pattern_id uuid references works_shift_patterns(id) on delete set null,
  user_id            uuid unique references users(id) on delete set null, -- ログイン利用者との紐づけ
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists works_staff_status_idx on works_staff (status);

-- ---------------------------------------------------------------------------
-- 勤務体系（現行: 担当者作業マスタ）。適用開始日つきで履歴を持つ
--   weekday_pattern_ids: 日〜土の 7 要素（null は休み）
--   break_overrides    : 曜日別の例外休憩 [{ "dow": 1, "start": "12:00", "end": "12:30" }, ...]
-- ---------------------------------------------------------------------------
create table if not exists works_staff_schedules (
  id                  uuid primary key default gen_random_uuid(),
  staff_id            uuid not null references works_staff(id) on delete cascade,
  valid_from          date not null,
  main_site_id        uuid references works_sites(id) on delete set null,
  weekday_pattern_ids uuid[] not null default array[null,null,null,null,null,null,null]::uuid[],
  break_overrides     jsonb not null default '[]'::jsonb,
  holiday_work        boolean not null default false, -- 祝日も予定を入れる
  commute_allowance   boolean not null default false, -- 通勤手当の対象
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (staff_id, valid_from)
);

-- ---------------------------------------------------------------------------
-- 設定（現行: Parm）。1 行だけ
-- ---------------------------------------------------------------------------
create table if not exists works_settings (
  id                   integer primary key default 1 check (id = 1),
  break_windows        jsonb not null default '[{"start":"12:00","end":"13:00"}]'::jsonb,
  rounding_minutes     integer not null default 30,
  schedule_create_day  integer not null default 20,  -- 翌月の予定を自動作成する日
  invite_valid_days    integer not null default 7,
  company_holidays     jsonb not null default '[]'::jsonb, -- 会社休日（年末年始など）["2026-12-30", ...]
  updated_at           timestamptz not null default now()
);
insert into works_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 招待（初回登録・パスワード再設定。docs/eworks-plan.md 11-2）
--   合言葉はハッシュ（SHA-256）だけを保存。1 回使うと無効
-- ---------------------------------------------------------------------------
create table if not exists works_invites (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references works_staff(id) on delete cascade,
  kind        text not null default 'register' check (kind in ('register', 'reset')),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists works_invites_staff_idx on works_invites (staff_id);

-- ---------------------------------------------------------------------------
-- 権限（このファイルの全テーブル）
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['works_shift_patterns','works_sites','works_staff','works_staff_schedules','works_settings','works_invites'] loop
    execute format('grant select, insert, update, delete on %I to service_role', t);
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;
