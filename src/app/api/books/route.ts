import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// GET: 書籍一覧取得 / ISBNs取得 / Upsert
// action=isbns → 登録済みISBN一覧
// action=upsert → 書籍upsert（スケジュールタスク用）
// それ以外 → 通常の書籍一覧
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const action = searchParams.get('action')

  // === action=isbns: 登録済みISBN一覧（ページネーション対応）===
  if (action === 'isbns') {
    const allBooks: Array<{ isbn: string | null; title: string; author: string }> = []
    const PAGE = 1000
    let from = 0
    let hasMore = true
    while (hasMore) {
      const { data: page, error: pageError } = await supabase
        .from('books')
        .select('isbn, title, author')
        .range(from, from + PAGE - 1)
      if (pageError) {
        return NextResponse.json({ error: pageError.message }, { status: 500 })
      }
      if (page && page.length > 0) {
        allBooks.push(...page)
        from += page.length
        hasMore = page.length === PAGE
      } else {
        hasMore = false
      }
    }
    const isbns = allBooks
      .map((b) => b.isbn)
      .filter((isbn): isbn is string => isbn !== null)
    const titles = allBooks.map((b) => `${b.title}|${b.author}`)
    return NextResponse.json({ isbns, titles, count: allBooks.length })
  }

  // === action=dedup: 重複書籍を検出・削除 ===
  if (action === 'dedup') {
    const dryRun = searchParams.get('mode') === 'dry-run'

    // 全書籍を取得（ページネーション）
    const allBooks: Array<{ id: string; isbn: string | null; title: string; author: string; rank: string | null; discovered_at: string }> = []
    const PAGE = 1000
    let from = 0
    let hasMore = true
    while (hasMore) {
      const { data: page, error: pageError } = await supabase
        .from('books')
        .select('id, isbn, title, author, rank, discovered_at')
        .range(from, from + PAGE - 1)
      if (pageError) {
        return NextResponse.json({ error: pageError.message }, { status: 500 })
      }
      if (page && page.length > 0) {
        allBooks.push(...page)
        from += page.length
        hasMore = page.length === PAGE
      } else {
        hasMore = false
      }
    }

    const rankPriority: Record<string, number> = { '高確率': 3, '注目': 2, '中確率': 1 }
    const duplicateIds: string[] = []

    // ISBN重複の検出
    const isbnMap = new Map<string, typeof allBooks[0]>()
    for (const book of allBooks) {
      if (!book.isbn) continue
      if (isbnMap.has(book.isbn)) {
        const existing = isbnMap.get(book.isbn)!
        const existingRank = rankPriority[existing.rank || ''] || 0
        const newRank = rankPriority[book.rank || ''] || 0
        if (newRank > existingRank) {
          duplicateIds.push(existing.id)
          isbnMap.set(book.isbn, book)
        } else {
          duplicateIds.push(book.id)
        }
      } else {
        isbnMap.set(book.isbn, book)
      }
    }

    // タイトル+著者の重複検出（ISBNなし含む）
    const titleMap = new Map<string, typeof allBooks[0]>()
    for (const book of allBooks) {
      if (duplicateIds.includes(book.id)) continue
      const key = `${book.title}|${book.author}`
      if (titleMap.has(key)) {
        const existing = titleMap.get(key)!
        const existingRank = rankPriority[existing.rank || ''] || 0
        const newRank = rankPriority[book.rank || ''] || 0
        if (newRank > existingRank) {
          duplicateIds.push(existing.id)
          titleMap.set(key, book)
        } else {
          duplicateIds.push(book.id)
        }
      } else {
        titleMap.set(key, book)
      }
    }

    if (dryRun) {
      return NextResponse.json({
        mode: 'dry-run',
        totalBooks: allBooks.length,
        duplicatesFound: duplicateIds.length,
        afterCleanup: allBooks.length - duplicateIds.length,
      })
    }

    // 実際に削除
    let deleted = 0
    const BATCH = 50
    for (let i = 0; i < duplicateIds.length; i += BATCH) {
      const batch = duplicateIds.slice(i, i + BATCH)
      const { error } = await supabase.from('books').delete().in('id', batch)
      if (!error) deleted += batch.length
    }

    return NextResponse.json({
      totalBooks: allBooks.length,
      duplicatesDeleted: deleted,
      remaining: allBooks.length - deleted,
    })
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

  // rank=ranked → 高確率・注目・中確率のいずれかが付いた書籍のみ
  const limitParam = searchParams.get('limit')
  const pageLimit = limitParam ? parseInt(limitParam, 10) : 2000

  let query = supabase
    .from('books')
    .select('*')

  // 「[詳細取得中]」の未補完書籍を除外（検索時は除外しない）
  if (!search) {
    query = query.not('title', 'like', '[詳細取得中]%')
  }

  if (search) {
    query = query.or(`title.ilike.%${search}%,author.ilike.%${search}%,publisher.ilike.%${search}%`)
  }
  if (status) {
    query = query.eq('status', status)
  }
  if (rank === 'ranked') {
    query = query.in('rank', ['高確率', '注目', '中確率'])
  } else if (rank) {
    query = query.eq('rank', rank)
  }
  query = query
    .order(sort, { ascending: order === 'asc', nullsFirst: false })
    .limit(pageLimit)

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

// PATCH: 書籍更新（SNSデータ手動修正等）
export async function PATCH(request: NextRequest) {
  const body = await request.json()
  const { id, ...updates } = body

  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('books')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data)
}
