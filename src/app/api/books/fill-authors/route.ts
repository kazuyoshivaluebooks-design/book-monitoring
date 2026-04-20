import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

/**
 * POST /api/books/fill-authors
 * 著者名が空の書籍に対して openBD API で著者名・出版社を補完する
 *
 * openBD は ISBN を最大1000件まで一括取得可能
 * https://openbd.jp/
 *
 * Body: { limit?: number } (default: 100)
 *
 * 補完後、evaluation_reason に 'SNS調査スキップ' が含まれる書籍の
 * evaluation_reason と sns_data をリセットしてSNS再調査可能にする
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const limit = Math.min(body.limit || 100, 200)

    // 著者名が空の書籍を取得
    const { data: booksNoAuthor, error } = await supabase
      .from('books')
      .select('id, isbn, title, author, publisher, evaluation_reason')
      .or('author.is.null,author.eq.')
      .not('isbn', 'is', null)
      .limit(limit)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!booksNoAuthor || booksNoAuthor.length === 0) {
      return NextResponse.json({
        message: '著者名が空の書籍はありません',
        updated: 0,
        remaining: 0,
      })
    }

    // ISBNリストを作成（ハイフンなし13桁に正規化）
    const isbnList = booksNoAuthor
      .map(b => b.isbn?.replace(/[^0-9X]/gi, ''))
      .filter((isbn): isbn is string => !!isbn && isbn.length >= 10)

    if (isbnList.length === 0) {
      return NextResponse.json({
        message: '有効なISBNがありません',
        updated: 0,
        remaining: 0,
      })
    }

    // openBD API で一括取得（最大1000件、カンマ区切り）
    const openbdUrl = `https://api.openbd.jp/v1/get?isbn=${isbnList.join(',')}`
    const openbdRes = await fetch(openbdUrl, { signal: AbortSignal.timeout(8000) })

    if (!openbdRes.ok) {
      return NextResponse.json(
        { error: `openBD API error: HTTP ${openbdRes.status}` },
        { status: 502 }
      )
    }

    const openbdData = await openbdRes.json()

    // ISBN → openBD データのマップを作成
    const openbdMap = new Map<string, { author: string; publisher: string }>()
    if (Array.isArray(openbdData)) {
      for (let i = 0; i < openbdData.length; i++) {
        const item = openbdData[i]
        if (!item || !item.summary) continue
        const isbn = isbnList[i]
        const author = item.summary.author || ''
        const publisher = item.summary.publisher || ''
        if (author || publisher) {
          openbdMap.set(isbn, { author, publisher })
        }
      }
    }

    // Supabase を更新
    let updated = 0
    let resetForSns = 0
    const results: Array<{ isbn: string; title: string; author: string; publisher: string }> = []

    for (const book of booksNoAuthor) {
      const isbn = book.isbn?.replace(/[^0-9X]/gi, '')
      if (!isbn) continue

      const info = openbdMap.get(isbn)
      if (!info || !info.author) continue

      // 著者名と出版社を更新
      const updateData: Record<string, string | null> = {}
      if (info.author && (!book.author || book.author.trim() === '')) {
        updateData.author = info.author
      }
      if (info.publisher && (!book.publisher || book.publisher.trim() === '')) {
        updateData.publisher = info.publisher
      }

      if (Object.keys(updateData).length === 0) continue

      // SNS調査スキップ状態をリセット（著者名が入ったので再調査可能に）
      if (book.evaluation_reason?.includes('SNS調査スキップ')) {
        updateData.evaluation_reason = null as unknown as string
        updateData.sns_data = '{}' as unknown as string
        resetForSns++
      }

      const { error: updateError } = await supabase
        .from('books')
        .update(updateData)
        .eq('id', book.id)

      if (!updateError) {
        updated++
        results.push({
          isbn,
          title: book.title,
          author: info.author,
          publisher: info.publisher,
        })
      }
    }

    // 残りの著者名空の書籍数
    const { count: remainingCount } = await supabase
      .from('books')
      .select('id', { count: 'exact', head: true })
      .or('author.is.null,author.eq.')

    return NextResponse.json({
      processed: booksNoAuthor.length,
      found: openbdMap.size,
      updated,
      resetForSns,
      remaining: remainingCount || 0,
      results: results.slice(0, 30), // サンプル表示
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
