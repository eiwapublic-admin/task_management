import { createClient } from '@supabase/supabase-js'

// Supabase の URL と anon キーは「公開してよい値」（RLS で保護される前提の publishable key）。
// ビルド時の環境変数があればそれを優先し、無ければ本番プロジェクトの値にフォールバックする。
// これによりビルド環境の設定漏れで画面全体がクラッシュ（真っ白）するのを防ぐ。
const DEFAULT_SUPABASE_URL = 'https://pfiogfdnbctunkhslmcp.supabase.co'
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_WBRnQarqBPYsKxuOtycKog_Ggeu5IPN'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
