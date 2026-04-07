import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co'
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-key'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// 型定義
export type SnsData = {
  x?: { followers: number; url?: string }
  instagram?: { followers: number; url?: string }
  youtube?: { subscribers: number; url?: string }
  tiktok?: { followers: number; url?: string }
  facebook?: { followers: number; url?: string }
  voicy?: { followers: number; url?: string }
  note?: { followers: number; url?: string }
  other?: string
}

export type Book = {
  id: string
  title: string
  author: string
  publisher: string | null
  isbn: string | null
  price: number | null
  release_date: string | null
  c_code: string | null
  genre: string | null
  rank: '高確率' | '中確率' | '注目' | null
  status: '未対応' | '仕入検討中' | '仕入済' | '見送り'
  sns_data: SnsData
  evaluation_reason: string | null
  source: string | null
  discovered_at: string
  created_at: string
  updated_at: string
}
