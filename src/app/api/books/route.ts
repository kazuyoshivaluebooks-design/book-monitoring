import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// GET: 書籍一覧取得（フィルタ・検索対応）
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const search = searchParams.get('search') || ''
  const status = searchParams.get('status') || ''
  const rank = searchParams.get('rank') || ''
  const sort = searchParams.get('sort') || 'discovered_at'
  const order = searchParams.get('order') || 'desc'

  let query = supabase
    .from('books')
    .select('*')

  // 検索
  if (search) {
    query = query.or(`title.ilike.%${search}%,author.ilike.%${search}%,publisher.ilike.%${search}%`)
  }

  // フィルタ
  if (status) {
    query = query.eq('status', status)
  }
  if (rank) {
    query = query.eq('rank', rank)
  }

  // ソート
  query = query.order(sort, { ascending: order === 'asc' })

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data)
}

// POST: 書籍追加
export async function POST(request: NextRequest) {
  const body = await request.json()

  const { data, error } = await supabase
    .from('books')
    .insert(body)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data, { status: 201 })
}
