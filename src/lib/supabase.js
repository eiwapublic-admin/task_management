import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    'Supabase の環境変数が設定されていません。.env に VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を設定してください。'
  )
}

export const supabase = createClient(supabaseUrl ?? '', supabaseAnonKey ?? '')
