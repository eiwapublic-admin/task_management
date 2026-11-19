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

-- ===========================================================================
-- Phase 2（2026-11-19）: 予定（勤務区間）と自動作成
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 勤務区間（現行: 勤務表作業明細）。Phase 2 では予定だけを持ち、実績の列は Phase 3 以降で足す
--   1 人 1 日に複数行を持てる（2 つの現場を回る日）
--   source: auto = 勤務体系から自動作成 / manual = 管理者が手で追加・変更（再作成で上書きしない）
-- ---------------------------------------------------------------------------
create table if not exists works_shifts (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references works_staff(id) on delete cascade,
  work_date   date not null,
  site_id     uuid references works_sites(id) on delete set null,
  pattern_id  uuid references works_shift_patterns(id) on delete set null,
  plan_start  time not null,
  plan_end    time not null,
  source      text not null default 'auto' check (source in ('auto', 'manual')),
  note        text,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (plan_start < plan_end)
);
create index if not exists works_shifts_staff_date_idx on works_shifts (staff_id, work_date);
create index if not exists works_shifts_date_idx on works_shifts (work_date);

-- スタッフごとの「休館日も勤務する」（オンなら日報カレンダーの休館日にも予定を作る。2026-11-19）
alter table works_staff add column if not exists closed_day_work boolean not null default false;

-- 自動作成を同じ月に 2 回走らせないための印（'2026-12' のように持つ）
alter table works_settings add column if not exists last_auto_month text;

-- 1 人 1 か月分の自動作成分を入れ替える（1 トランザクション）。
--   手で直した日（source='manual' がある日）は自動分を入れない
--   p_rows: [{ "work_date": "2026-12-01", "site_id": "…", "pattern_id": "…", "plan_start": "06:30", "plan_end": "14:30" }, …]
create or replace function works_replace_auto_shifts(p_staff uuid, p_from date, p_to date, p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare n integer;
begin
  delete from works_shifts
   where staff_id = p_staff and work_date between p_from and p_to and source = 'auto';
  insert into works_shifts (staff_id, work_date, site_id, pattern_id, plan_start, plan_end, source)
  select p_staff, r.work_date, r.site_id, r.pattern_id, r.plan_start, r.plan_end, 'auto'
    from jsonb_to_recordset(p_rows) as r(work_date date, site_id uuid, pattern_id uuid, plan_start time, plan_end time)
   where r.work_date between p_from and p_to
     and not exists (
       select 1 from works_shifts m
        where m.staff_id = p_staff and m.work_date = r.work_date and m.source = 'manual'
     );
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function works_replace_auto_shifts(uuid, date, date, jsonb) from public, anon, authenticated;
grant execute on function works_replace_auto_shifts(uuid, date, date, jsonb) to service_role;

do $$
declare t text;
begin
  foreach t in array array['works_shifts'] loop
    execute format('grant select, insert, update, delete on %I to service_role', t);
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;
