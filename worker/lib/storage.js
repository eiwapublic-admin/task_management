// Supabase Storage の薄いクライアント（2026-08-04〜。日報の写真保管用。
// 2026-08-30に雛形ファイル（work-templates バケット）用に bucket 引数を追加）。
// supabase-js のストレージ機能は使わず fetch を直叩きする（gmail.js と同じ方針。
// Worker 上での依存を増やさないため）。
//
// バケットはすべて**非公開**。anon/authenticated からは直接読めず、
// 取得は必ずこの service role キー経由（＝Worker の JWT 認証を通った後）になる。

import { resolveSupabaseUrl } from './supabase-admin.js'

export const PHOTO_BUCKET = 'report-photos'
// 業務で使う雛形ファイル（Word/Excel/PDF等）専用バケット（2026-08-30）。
// 写真と混在させず別バケットに分けることで、用途ごとに削除・容量把握がしやすいようにする
export const TEMPLATE_BUCKET = 'work-templates'

function storageBase() {
  return `${resolveSupabaseUrl().replace(/\/$/, '')}/storage/v1`
}

function serviceKey() {
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_KEY が設定されていません')
  return key
}

// 新方式のシークレットキー（sb_secret_...）はJWTではないため、Authorization: Bearer に載せると
// 「JWTとして解釈できない」扱いで拒否される（Supabase公式ドキュメント）。apikeyヘッダのみを送る。
// 旧方式（JWT形式のservice_role。eyJ...で始まる）は従来どおり両方に載せる（後方互換）。
function authHeaders() {
  const key = serviceKey()
  if (key.startsWith('sb_secret_')) return { apikey: key }
  return { Authorization: `Bearer ${key}`, apikey: key }
}

// オブジェクトを保存する。既定では既存キーを上書きしない（キーは毎回 uuid で作るため
// 衝突しない想定）。upsert: true を渡すと固定キーを毎回上書きできる（自主検査表PDFの
// プレビュー保存など、ユーザーごとに1個だけ保持して溜め込みたくない用途向け）。
export async function putObject(key, body, contentType, { upsert = false, bucket = PHOTO_BUCKET } = {}) {
  const res = await fetch(`${storageBase()}/object/${bucket}/${encodeURI(key)}`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': upsert ? 'true' : 'false',
    },
    body,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`storage put 失敗 (${res.status}): ${detail.slice(0, 200)}`)
  }
  return key
}

// オブジェクトを取得する。戻り値は Response（呼び出し側でそのまま body を流せる）
export async function getObject(key, bucket = PHOTO_BUCKET) {
  const res = await fetch(`${storageBase()}/object/${bucket}/${encodeURI(key)}`, {
    headers: authHeaders(),
  })
  return res
}

// オブジェクトを削除する。存在しない場合もエラーにしない（冪等）
export async function deleteObject(key, bucket = PHOTO_BUCKET) {
  const res = await fetch(`${storageBase()}/object/${bucket}`, {
    method: 'DELETE',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefixes: [key] }),
  })
  if (!res.ok && res.status !== 404) {
    const detail = await res.text().catch(() => '')
    console.error(`storage delete 失敗 (${res.status}): ${detail.slice(0, 200)}`)
  }
}

// バケット全体の使用量を集計する（「従量課金事項」画面のストレージ使用量表示に使う）。
// storage.objects の metadata から size を合計する方式は SQL 側で行うため、
// ここでは提供しない（reports.js が Supabase 経由で集計する）。
