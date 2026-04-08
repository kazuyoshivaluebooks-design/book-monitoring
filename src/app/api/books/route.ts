import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// GET: 書籍一覧取得 / ISBNs取得 / Upsert
// action=isbns → 登録済みISBN一覧
// action=upsert → 書籍upsert（スケジュールタスク用）
// それ以外 → 通常の書籍一覧
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action')

  // === action=isbns: 登録済みISBN一覧 ===
  if (action === 'isbns') {
    const { data, error } = await supabase
      .from('books')
      .select('isbn, title, author')
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    const isbns = data
      .map((b) => b.isbn)
      .filter((isbn): isbn is string => isbn !== null)
    const titles = data.map((b) => `${b.title}|${b.author}`)
    return NextResponse.json({ isbns, titles, count: data.length })
  }

  // === action=upsert: 書籍upsert ===
  if (action === 'upsert') {
    const title = searchParams.get('title')
    const author = searchParams.get('author')
    if (!title || !author) {
      return NextResponse.json({ error: 'title and author are required' }, { status: 400 })
    }
    const isbn = searchParams.get('isbn') || null
    const publisher = searchParams.get('publisher') || null
    const release_date = searchParams.get('release_date') || null
    const c_code = searchParams.get('c_code') || null
    const genre = searchParams.get('genre') || null
    const rankParam = searchParams.get('rank') || null
    const statusParam = searchParams.get('status') || '未対応'
    const source = searchParams.get('source') || 'jpro'
    const evaluation_reason = searchParams.get('evaluation_reason') || null
    const price_str = searchParams.get('price')
    const price = price_str ? parseInt(price_str, 10) : null

    let sns_data = {}
    const sns_json = searchParams.get('sns_json')
    if (sns_json) {
      try {
        const decoded = Buffer.from(sns_json, 'base64').toString('utf-8')
        sns_data = JSON.parse(decoded)
      } catch {
        sns_data = {}
      }
    }

    const bookData = {
      title, author, publisher, isbn, price, release_date,
      c_code, genre, rank: rankParam, status: statusParam,
      sns_data, evaluation_reason, source,
    }

    let existingBook = null
    if (isbn) {
      const { data } = await supabase.from('books').select('id').eq('isbn', isbn).maybeSingle()
      existingBook = data
    } else {
      const { data } = await supabase.from('books').select('id').eq('title', title).eq('author', author).maybeSingle()
      existingBook = data
    }

    if (existingBook) {
      const updateData = { ...bookData }
      delete (updateData as Record<string, unknown>).status
      const { data, error } = await supabase.from('books').update(updateData).eq('id', existingBook.id).select().single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ action: 'updated', book: data })
    } else {
      const { data, error } = await supabase.from('books').insert(bookData).select().single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ action: 'created', book: data }, { status: 201 })
    }
  }

  // === デフォルト: 書籍一覧取得 ===
  const search = searchParams.get('search') || ''
  const status = searchParams.get('status') || ''
  const rank = searchParams.get('rank') || ''
  const sort = searchParams.get('sort') || 'discovered_at'
  const order = searchParams.get('order') || 'desc'

  let query = supabase
    .from('books')
    .select('*')

  if (search) {
    query = query.or(`title.ilike.%${search}%,author.ilike.%${search}%,publisher.ilike.%${search}%`)
  }
  if (status) {
    query = query.eq('status', status)
  }
  if (rank) {
    query = query.eq('rank', rank)
  }
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
