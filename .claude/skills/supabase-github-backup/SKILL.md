---
name: supabase-github-backup
description: Set up (or debug) a daily, no-cost Supabase Postgres backup for apps on the free plan, which has no built-in automatic backups. Uses a GitHub Actions workflow that runs `pg_dump` directly against Supabase's Session pooler and commits schema.sql/data.sql/auth_data.sql to a separate private "backups" repo (generational history via git log), plus a disaster-recovery runbook for restoring into a fresh Supabase project and rebuilding platform config that isn't in git. Covers the non-obvious failure modes that make this fragile: Supabase CLI silently mangling the pooler username (must use pg_dump directly instead), Transaction pooler (6543) not working with pg_dump (must use Session pooler 5432), GitHub Actions runners being IPv4-only so Supabase's direct connection needs a paid add-on, pg_dump client/server major-version mismatches, password whitespace/URL-encoding, restore ordering (schema → auth_data → data, since data has FKs into auth.users), and psql's `:'var'` substitution silently failing when passed via `-c` instead of stdin (dangerous when wrapped in `continue-on-error`, since it hides the failure indefinitely). Use whenever setting up backups for a new Supabase app, restoring/migrating a Supabase project, writing a disaster-recovery doc, or debugging a backup workflow that fails auth, fails on server-version-mismatch, or silently never writes to an activity/operation log.
---

# Supabase → GitHub Actions daily backup + restore

For Supabase apps on the **free plan** (no built-in Point-in-Time-Recovery or automatic
backups — Pro tier and above only). Ports the exact pattern battle-tested in this repo
(`.github/workflows/backup.yml`, `docs/disaster-recovery.md`) to a new app.

## Why this shape

- **Free plan → no automatic backups.** Supabase's own docs recommend `pg_dump` + offsite
  storage for free-tier projects.
- **Backups live in a *separate* private repo**, not the app's own repo, so that either
  Supabase or the hosting platform can be lost independently and the backup still survives
  (third location). Losing the app repo doesn't take the data with it, and vice versa.
- **Generations = git history.** No pruning/retention logic needed — `git show HEAD~N:data.sql`
  recovers any past day for as long as the repo exists. This incidentally satisfies
  multi-year data-retention requirements for free.
- **Bonus side effect**: the daily `pg_dump` is a real DB connection, which also prevents
  Supabase's free-tier "paused after 7 days of no activity" — no separate keep-alive ping needed.

## Setup

1. Create an empty **private** repo for backups only, e.g. `<app>-backups`. No code, just
   the three dump files land there.
2. Create a fine-grained GitHub PAT scoped to *only* that repo, Contents: Read and write,
   with an expiry (a year is fine — the workflow warns before it lapses).
3. In the app's repo, add secrets: `SUPABASE_DB_PASSWORD` (raw, no URL-encoding) and
   `BACKUP_REPO_TOKEN` (the PAT from step 2).
4. Copy `assets/backup.yml` to `.github/workflows/backup.yml`, fill in the `env:` block —
   `BACKUP_REPO`, `DB_HOST` (region-specific pooler host), `DB_USER` (`postgres.<project-ref>`).
5. If the app has no activity/operation-log table, delete the two optional "操作ログに記録"
   steps at the bottom (they're for surfacing backup status in the app's own admin UI without
   checking GitHub — nice to have, not required).
6. Trigger `workflow_dispatch` once manually and confirm a commit lands in the backups repo.
7. Copy `assets/disaster-recovery.md` into `docs/`, fill in the `<...>` placeholders, and
   write the app-specific platform-rebuild steps in its §4/§5 (see "What this does NOT
   capture" below).

## Critical gotchas (each one has bitten this exact setup before)

- **Never use the Supabase CLI to take the dump.** It re-parses the connection URL before
  invoking `pg_dump` internally, and drops the Session-pooler-required username qualifier
  (`postgres.<project-ref>` → `postgres`), which then fails auth. Call `pg_dump` directly
  against a manually-built connection string instead.
- **Must connect via the Session pooler, port 5432 — not the Transaction pooler (6543).**
  `pg_dump` needs prepared-statement support that the transaction pooler doesn't provide.
- **Direct connection (`db.<ref>.supabase.co`) won't work from GitHub Actions.** Actions
  runners are IPv4-only, and Supabase's direct connection requires a paid IPv4 add-on without
  it. The Session pooler is reachable over IPv4 on the free plan.
- **`password authentication failed for user "postgres"` does not mean the username is
  wrong.** The Session pooler always reports the generic `postgres` in that error even when
  you correctly sent `postgres.<project-ref>` — it identifies the project internally then
  authenticates as `postgres`. Don't chase the username on this specific error; check the
  connection-test step's result instead to tell credential vs. dump-step problems apart.
- **`pg_dump` (client) must match the Postgres server's major version**, or it aborts with
  "server version mismatch." GitHub's ubuntu runners often ship an older client — install the
  matching version from the PGDG apt repo and prepend it onto `$GITHUB_PATH` so it's picked up
  ahead of the system one.
- **Strip the DB password of trailing whitespace/newlines before URL-encoding it.** Pasting
  into a GitHub secret commonly appends a `\n`, which then encodes as `%0A` and silently
  breaks auth with no useful error.
- **`::add-mask::` the assembled connection string** before writing it anywhere, so a
  password never leaks into workflow logs even indirectly.
- **Restore order is schema → auth_data → data, never data before auth_data.** `data.sql`
  (public schema) contains rows with foreign keys into `auth.users`; loading it before
  `auth_data.sql` throws FK-violation errors partway through the load.
- **Two errors during schema restore are expected and safe to ignore**: `schema "public"
  already exists` (every fresh project starts with one) and `permission denied to change
  default privileges` (the pooler role isn't a superuser; Supabase's own default grants cover
  this in practice).
- **`psql`'s `:'var'` substitution only works when SQL is piped via stdin/heredoc — not when
  passed as a `-c` argument.** `psql -c "insert ... values(:'x')"` fails with `syntax error at
  or near ":"`. Use a heredoc/here-string (`<<< "$SQL_TEXT"`) instead. This matters more than
  it sounds: if that step also has `continue-on-error: true` (e.g. an optional
  "write to app log" step that shouldn't fail the whole backup), the substitution bug makes
  the step **fail every single run while the workflow still shows green**, hiding a
  silently-broken feature indefinitely. Whenever you add a `continue-on-error` step, trigger
  it manually once and verify its actual side effect (e.g., the row really landed in the
  table) — not just that the job went green.
- **Watch the PAT's expiry, not just the DB password.** The token-expiry-check step reads the
  `github-authentication-token-expiration` response header from a `GET /user` call and warns
  at ≤30 days left; wire that warning into wherever the app's owner will actually see it.
- **If backing up Storage file contents too, and the project uses Supabase's newer
  `sb_secret_...`/`sb_publishable_...` API keys: never send that key on `Authorization:
  Bearer`.** Those keys aren't JWTs, and the platform rejects the request outright if you do.
  Send `apikey: <key>` only. Legacy JWT-format `service_role` keys still need both headers.
  Branch on the key's prefix rather than hardcoding one or the other, since a project can
  migrate between the two formats over its lifetime.
- **When downloading/uploading Storage object paths, percent-encode each path segment but
  leave `/` alone** — Supabase object names can contain `/` as a virtual "folder" separator.
  `jq`'s `@uri` filter (like JS `encodeURIComponent`) encodes `/` too, which breaks such
  paths; split on `/`, encode each segment, then rejoin (matching JS `encodeURI()`, which the
  app's own upload code should already be using for the same reason).
- **Don't let one missing/already-deleted Storage object fail the whole backup job.** A file
  can be deleted between the `storage.objects` listing and the per-object download a few
  seconds later — treat that one failure as a warning and keep going, so a real DB backup
  success isn't reported as a failure over an unrelated race condition.

## What this does NOT capture (must be a separate manual runbook)

`pg_dump` only gets the database. These are Supabase/hosting **dashboard-only** settings with
no git representation — losing the project loses them too unless documented separately:

- Auth → URL Configuration (Site URL, Redirect URLs)
- Auth → Email templates and SMTP settings
- Storage bucket **definitions** (`storage.buckets` — public/private, size limits) are
  **not** in `schema.sql` either, since that dump is `--schema=public` only and `storage`
  is a separate schema. Bucket file *contents* can be captured with an extra step: list
  `storage.objects` (path + mimetype metadata, no bytes) via `psql`, then download each
  object's bytes from the Storage REST API (`GET /storage/v1/object/{bucket}/{path}`) and
  commit them alongside the SQL dumps. Restoring is the mirror: recreate the buckets, then
  re-upload each file to its *original* bucket+path via `POST .../object/{bucket}/{path}`
  with `x-upsert: true`. Because the app's own DB rows reference that path string directly
  (not a Supabase-internal object ID), restoring to the same path re-establishes the DB↔file
  link with no reconciliation step. See `eiwapublic-admin/task_management`'s
  `.github/workflows/backup.yml` (Storage step) and `docs/disaster-recovery.md` §3-1 for a
  working reference implementation, including the header quirk below.
- Any platform secrets/env vars on the hosting side (Cloudflare/Vercel/etc. dashboard vars)
- The PAT and DB password themselves — must live in a password manager; nothing in this
  pipeline stores them for you

`assets/disaster-recovery.md` has placeholder sections (§4/§5) for exactly this — fill them
in per-app rather than assuming the dump alone is sufficient for a full recovery.

## Pieces

| File | Role |
|---|---|
| `assets/backup.yml` | GitHub Actions workflow template. Copy to `.github/workflows/backup.yml`, fill in the `env:` placeholders. |
| `assets/disaster-recovery.md` | Restore runbook template. Copy to `docs/`, fill in `<...>` placeholders and the platform-rebuild sections (§4/§5). |

## Verification

- `workflow_dispatch` run succeeds; a new commit with `schema.sql`/`data.sql`/`auth_data.sql`
  appears in the backups repo.
- Do a real restore drill at least once (and again annually): spin up a second free Supabase
  project, run the §3 restore commands from `disaster-recovery.md` against it, and confirm
  login + core data actually work. **An untested backup is not a backup** — this exact repo's
  restore-order bug (data before auth_data) was only found by actually doing this.
- If the app has an activity/operation log, confirm a `バックアップ`/`backup` entry actually
  appears after a manual run — not just that the workflow step shows green (see the
  `continue-on-error` gotcha above).
