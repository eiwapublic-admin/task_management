// Supabase Storage の薄いクライアント（2026-08-04〜。日報の写真保管用）。
// supabase-js のストレージ機能は使わず fetch を直叩きする（gmail.js と同じ方針。
// Worker 上での依存を増やさないため）。
//
// バケット `report-photos` は**非公開**。anon/authenticated からは直接読めず、
// 取得は必ずこの service role キー経由（＝Worker の JWT 認証を通った後）になる。
// 保管先を差し替える場合はこのファイルの3関数を差し替えれば済むようにしてある。

import { resolveSupabaseUrl } from './supabase-admin.js'

export const PHOTO_BUCKET = 'report-photos'

function storageBase() {
  return `${resolveSupabaseUrl().replace(/\/$/, '')}/storage/v1`
}

function serviceKey() {
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_KEY が設定されていません')
  return key
}

// オブジェクトを保存する。既存キーは上書きしない（キーは毎回 uuid で作るため衝突しない想定）
export async function putObject(key, body, contentType) {
  const res = await fetch(`${storageBase()}/object/${PHOTO_BUCKET}/${encodeURI(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey()}`,
      apikey: serviceKey(),
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'false',
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
export async function getObject(key) {
  const res = await fetch(`${storageBase()}/object/${PHOTO_BUCKET}/${encodeURI(key)}`, {
    headers: { Authorization: `Bearer ${serviceKey()}`, apikey: serviceKey() },
  })
  return res
}

// オブジェクトを削除する。存在しない場合もエラーにしない（冪等）
export async function deleteObject(key) {
  const res = await fetch(`${storageBase()}/object/${PHOTO_BUCKET}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${serviceKey()}`,
      apikey: serviceKey(),
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
