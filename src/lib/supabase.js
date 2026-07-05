import { createClient } from '@supabase/supabase-js'

// Supabase の URL と anon キーは「公開してよい値」（RLS で保護される前提の publishable key）。
// ビルド時の環境変数が正しい形式の場合のみ優先し、未設定・不正な値のときは
// 本番プロジェクトの値にフォールバックする（設定ミスで画面全体が真っ白になるのを防ぐ）。
const DEFAULT_SUPABASE_URL = 'https://pfiogfdnbctunkhslmcp.supabase.co'
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_WBRnQarqBPYsKxuOtycKog_Ggeu5IPN'

function validUrlOrNull(value) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null
  } catch {
    return null
  }
}

const supabaseUrl = validUrlOrNull(import.meta.env.VITE_SUPABASE_URL) || DEFAULT_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
