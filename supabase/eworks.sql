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

-- =============================================================================
-- Phase 3: QR 打刻（docs/eworks-plan.md 6章。2026-11-19）
-- =============================================================================

-- 現場の QR を発行した日時（合言葉はハッシュだけを qr_secret_hash に持つ。再発行で古い QR は無効）
alter table works_sites add column if not exists qr_issued_at timestamptz;

-- 勤務区間の採用時刻（打刻を 30 分単位で丸め、予定の範囲にそろえた時刻。6-5）
alter table works_shifts add column if not exists actual_start time;
alter table works_shifts add column if not exists actual_end   time;

-- 打刻の生データ。追記のみ（訂正・取消は別の行で残す。6-4）
create table if not exists works_punches (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references works_staff(id) on delete cascade,
  work_date   date not null,                    -- 日本時間の日付
  kind        text not null check (kind in ('in', 'out')),
  punched_at  timestamptz not null,             -- 打刻の時刻（通常はサーバー時刻。オフライン打刻は端末の時刻）
  received_at timestamptz not null default now(), -- サーバーが受け取った時刻
  device_at   timestamptz,                      -- 端末の時刻（参考値）
  method      text not null default 'qr' check (method in ('qr', 'proxy')), -- QR 打刻／管理者の代理入力
  site_id     uuid references works_sites(id) on delete set null,
  shift_id    uuid references works_shifts(id) on delete set null,
  adopted     time,                             -- この打刻から決めた採用時刻（丸め・予定へのそろえ後）
  lat         double precision,
  lng         double precision,
  accuracy_m  real,
  distance_m  integer,                          -- 現場の位置からの距離
  flags       text[] not null default '{}',     -- site_mismatch / no_plan / far / no_location / offline / duplicate / no_in / proxy
  note        text,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists works_punches_staff_date_idx on works_punches (staff_id, work_date);
create index if not exists works_punches_date_idx on works_punches (work_date);

-- 打刻を 1 件記録し、勤務区間の採用時刻を更新する（1 トランザクション）。
--   p_punch: works_punches の列の JSON。p_start / p_end: 勤務区間に入れる採用時刻（null なら変えない）
create or replace function works_record_punch(p_punch jsonb, p_start time, p_end time)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare new_id uuid;
begin
  insert into works_punches (staff_id, work_date, kind, punched_at, device_at, method, site_id, shift_id, adopted,
                             lat, lng, accuracy_m, distance_m, flags, note, created_by)
  select r.staff_id, r.work_date, r.kind, r.punched_at, r.device_at, coalesce(r.method, 'qr'), r.site_id, r.shift_id, r.adopted,
         r.lat, r.lng, r.accuracy_m, r.distance_m, coalesce(r.flags, '{}'), r.note, r.created_by
    from jsonb_to_record(p_punch) as r(staff_id uuid, work_date date, kind text, punched_at timestamptz, device_at timestamptz,
                                       method text, site_id uuid, shift_id uuid, adopted time, lat double precision,
                                       lng double precision, accuracy_m real, distance_m integer, flags text[], note text,
                                       created_by uuid)
  returning id into new_id;
  if (p_punch->>'shift_id') is not null and (p_start is not null or p_end is not null) then
    update works_shifts
       set actual_start = coalesce(p_start, actual_start),
           actual_end   = coalesce(p_end, actual_end),
           updated_at   = now()
     where id = (p_punch->>'shift_id')::uuid;
  end if;
  return new_id;
end $$;
revoke all on function works_record_punch(jsonb, time, time) from public, anon, authenticated;
grant execute on function works_record_punch(jsonb, time, time) to service_role;

do $$
declare t text;
begin
  foreach t in array array['works_punches'] loop
    execute format('grant select, insert, update, delete on %I to service_role', t);
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;

-- =============================================================================
-- テレワーク（2026-11-19 依頼元の要望）
--   出退勤パターンに「テレワーク」。そのパターンで作った予定（勤務区間）にも印を写す（手で追加・変更するときも指定できる）。
--   テレワークの日の記録は自己申告（QR・位置情報なしでボタンを押した時刻。method='self'）。出勤簿の備考に「テレワーク」と出す（Phase 6）
-- =============================================================================
alter table works_shift_patterns add column if not exists telework boolean not null default false;
alter table works_shifts add column if not exists telework boolean not null default false;
alter table works_punches drop constraint if exists works_punches_method_check;
alter table works_punches add constraint works_punches_method_check check (method in ('qr', 'proxy', 'self'));

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
  insert into works_shifts (staff_id, work_date, site_id, pattern_id, plan_start, plan_end, telework, source)
  select p_staff, r.work_date, r.site_id, r.pattern_id, r.plan_start, r.plan_end, coalesce(r.telework, false), 'auto'
    from jsonb_to_recordset(p_rows) as r(work_date date, site_id uuid, pattern_id uuid, plan_start time, plan_end time, telework boolean)
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

-- =============================================================================
-- 有給休暇・特別休暇の取得日（2026-11-19。docs/eworks-spec-leave.md）
--   取得の記録が正。残日数などは毎回ここから計算する（保存しない）。同じ日は 1 日（kind ごとに 1 行）
--   特別休暇を登録すると同じ日の有休も登録する（決定 10）。FileMaker からの取込は source='import'
-- =============================================================================
create table if not exists works_leaves (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references works_staff(id) on delete cascade,
  leave_date  date not null,
  kind        text not null check (kind in ('paid', 'special')),
  source      text not null default 'manual' check (source in ('manual', 'import')),
  note        text,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (staff_id, leave_date, kind)
);
create index if not exists works_leaves_date_idx on works_leaves (leave_date);

do $$
declare t text;
begin
  foreach t in array array['works_leaves'] loop
    execute format('grant select, insert, update, delete on %I to service_role', t);
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;

-- =============================================================================
-- 有給休暇の申請（2026-11-19 依頼元の要望）
--   本人がアプリで申請 → 労務担当（eWorks 管理者）が承認すると works_leaves に入る。
--   紙の申請書は労務担当が代理で入力する（proxy=true、承認済みで登録）。連絡先は持たない（印刷した紙に手書き）
-- =============================================================================
create table if not exists works_leave_requests (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references works_staff(id) on delete cascade,
  kind          text not null default 'paid' check (kind in ('paid', 'special')),
  dates         date[] not null,
  reason        text,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  proxy         boolean not null default false,
  applied_by    uuid references users(id) on delete set null,
  applied_at    timestamptz not null default now(),
  decided_by    uuid references users(id) on delete set null,
  decided_at    timestamptz,
  decision_note text,
  updated_at    timestamptz not null default now()
);
create index if not exists works_leave_requests_staff_idx on works_leave_requests (staff_id, applied_at desc);
create index if not exists works_leave_requests_status_idx on works_leave_requests (status);
alter table works_leaves add column if not exists request_id uuid references works_leave_requests(id) on delete set null;

do $$
declare t text;
begin
  foreach t in array array['works_leave_requests'] loop
    execute format('grant select, insert, update, delete on %I to service_role', t);
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;

-- =============================================================================
-- 出退勤の入力方法（2026-11-20 依頼元の要望）
--   qr … 本人が現場の QR をかざす（これまでどおり）
--   self … 本人が時刻を直接入力（「予定通り」・1 か月一括も可）。日報の担当なら日報の時刻を自動で入れる
--   proxy … 手書きの出勤簿を見て管理者が代理入力
--   report_name … タスク管理の日報の担当名（例: 西川）。日報を保存するとその日の勤務に時刻を写す（テレワークの日は除く）
-- =============================================================================
alter table works_staff add column if not exists punch_method text not null default 'qr';
alter table works_staff drop constraint if exists works_staff_punch_method_check;
alter table works_staff add constraint works_staff_punch_method_check check (punch_method in ('qr', 'self', 'proxy'));
alter table works_staff add column if not exists report_name text;
-- 打刻の記録に「直接入力（manual）」「日報から（report）」を加える
alter table works_punches drop constraint if exists works_punches_method_check;
alter table works_punches add constraint works_punches_method_check check (method in ('qr', 'proxy', 'self', 'manual', 'report'));

-- =============================================================================
-- Phase 4: 要確認・通知・打刻の修正申請（docs/eworks-plan.md 8章・13-1。2026-11-24）
--   要確認の判定は毎回 予定・打刻・休暇 から計算する（判定結果そのものは保存しない）。
--   保存するのは「確認済みにした」「通知を送った」の印だけ（works_alert_states）。
-- =============================================================================

-- 判定のしきい値（分・m）。既定値は 2026-11-24 依頼元の決定どおり
alter table works_settings add column if not exists alert_rules jsonb not null
  default '{"absent_min":10,"late_min":5,"early_min":5,"no_out_min":60,"overtime_min":30}'::jsonb;
-- この日より前は要確認を出さない（運用を始める前の空の日を「未出勤」にしないため）
alter table works_settings add column if not exists alerts_from date;
update works_settings set alerts_from = (now() at time zone 'Asia/Tokyo')::date where id = 1 and alerts_from is null;

-- 要確認 1 件ごとの印。alert_key は「スタッフ:日付:勤務:種別」（判定のたびに同じ値になる）
create table if not exists works_alert_states (
  alert_key   text primary key,
  staff_id    uuid not null references works_staff(id) on delete cascade,
  work_date   date not null,
  kind        text not null,
  notified_at timestamptz,                  -- プッシュ通知を送った日時（同じ件で 2 回送らない）
  resolved_at timestamptz,                  -- 確認済みにした日時（null なら未確認）
  resolved_by uuid references users(id) on delete set null,
  note        text,                         -- 確認のメモ
  updated_at  timestamptz not null default now()
);
create index if not exists works_alert_states_date_idx on works_alert_states (work_date);

-- 打刻の修正申請（本人が申請 → 管理者が承認すると勤務の時刻に反映。6-3・13-1 の 3）
create table if not exists works_punch_requests (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references works_staff(id) on delete cascade,
  shift_id      uuid references works_shifts(id) on delete set null,
  work_date     date not null,
  start_time    time,                       -- 直したい出勤の時刻（null は変えない）
  end_time      time,                       -- 直したい退勤の時刻（null は変えない）
  reason        text not null,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  applied_by    uuid references users(id) on delete set null,
  applied_at    timestamptz not null default now(),
  decided_by    uuid references users(id) on delete set null,
  decided_at    timestamptz,
  decision_note text,
  updated_at    timestamptz not null default now()
);
create index if not exists works_punch_requests_staff_idx on works_punch_requests (staff_id, work_date);
create index if not exists works_punch_requests_status_idx on works_punch_requests (status);

-- eWorks のプッシュ通知の購読（端末ごと）。タスク管理の push_subscriptions とは分ける
-- （タスク管理の通知は購読中の全端末へ送るため、現場スタッフの端末に届かないようにする）
create table if not exists works_push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index if not exists works_push_subscriptions_user_idx on works_push_subscriptions (user_id);

-- 管理者が予定を変えた日時（本人のカレンダーに「変更あり」を出す。13-1 の 10）
alter table works_shifts add column if not exists plan_changed_at timestamptz;

-- 打刻の記録に「修正申請の承認（correction）」を加える
alter table works_punches drop constraint if exists works_punches_method_check;
alter table works_punches add constraint works_punches_method_check check (method in ('qr', 'proxy', 'self', 'manual', 'report', 'correction'));

do $$
declare t text;
begin
  foreach t in array array['works_alert_states','works_punch_requests','works_push_subscriptions'] loop
    execute format('grant select, insert, update, delete on %I to service_role', t);
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;

-- =============================================================================
-- 労務管理者（2026-11-25 依頼元の要望）
--   設定でスタッフから複数名を選ぶ（works_staff.id の配列）。休暇申請を承認できるのは労務管理者だけ
--   （空のときは eWorks 管理者全員）。申請が来たら労務管理者へ、承認・却下は本人へプッシュ通知する
-- =============================================================================
alter table works_settings add column if not exists labor_manager_ids uuid[] not null default '{}';
