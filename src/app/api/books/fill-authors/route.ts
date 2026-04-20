import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

/**
 * POST /api/books/fill-authors
 * 著者名が空の書籍に対して openBD + Google Books API で著者名・出版社を補完する
 *
 * 1) openBD で一括取得（無料、ISBN一括対応）
 * 2) openBD で見つからなかった分を Google Books API で個別取得
 *
 * 補完後、SNS調査スキップ状態を自動リセット
 *
 * Body: { limit?: number } (default: 50)
 */

/** openBD から著者・出版社を一括取得 */
async function fetchFromOpenBD(isbnList: string[]): Promise<Map<string, { author: string; publisher: string }>> {
  const result = new Map<string, { author: string; publisher: string }>()
  if (isbnList.length === 0) return result

  try {
    const url = `https://api.openbd.jp/v1/get?isbn=${isbnList.join(',')}`
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return result

    const data = await res.json()
    if (!Array.isArray(data)) return result

    for (let i = 0; i < data.length; i++) {
      const item = data[i]
      if (!item?.summary) continue
      const author = item.summary.author || ''
      const publisher = item.summary.publisher || ''
      if (author) {
        result.set(isbnList[i], { author, publisher })
      }
    }
  } catch {
    // openBD エラーは無視して Google Books にフォールバック
  }

  return result
}

/** Google Books API から著者・出版社を個別取得 */
async function fetchFromGoogleBooks(
  isbn: string,
  apiKey: string
): Promise<{ author: string; publisher: string } | null> {
  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&key=${apiKey}&maxResults=1`
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return null

    const data = await res.json()
    const item = data.items?.[0]?.volumeInfo
    if (!item) return null

    const author = item.authors?.join('、') || ''
    const publisher = item.publisher || ''
    if (!author) return null

    return { author, publisher }
  } catch {
    return null
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const limit = Math.min(body.limit || 50, 100)

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

    const startTime = Date.now()

    // ISBNリストを正規化
    const bookIsbnMap = new Map<string, typeof booksNoAuthor[0]>()
    for (const book of booksNoAuthor) {
      const isbn = book.isbn?.replace(/[^0-9X]/gi, '')
      if (isbn && isbn.length >= 10) {
        bookIsbnMap.set(isbn, book)
      }
    }
    const isbnList = Array.from(bookIsbnMap.keys())

    // 1) openBD で一括取得
    const openbdResults = await fetchFromOpenBD(isbnList)

    // 2) openBD で見つからなかった分を Google Books で取得
    const googleApiKey = process.env.GOOGLE_SEARCH_API_KEY || process.env.YOUTUBE_API_KEY
    const notFoundIsbns = isbnList.filter(isbn => !openbdResults.has(isbn))
    const googleResults = new Map<string, { author: string; publisher: string }>()

    if (googleApiKey && notFoundIsbns.length > 0) {
      for (const isbn of notFoundIsbns) {
        if (Date.now() - startTime > 7500) break // タイムアウト防止
        const result = await fetchFromGoogleBooks(isbn, googleApiKey)
        if (result) {
          googleResults.set(isbn, result)
        }
      }
    }

    // 結果を統合
    const allResults = new Map([...openbdResults, ...googleResults])

    // Supabase を更新
    let updated = 0
    let resetForSns = 0
    const results: Array<{ isbn: string; title: string; author: string; publisher: string; source: string }> = []

    for (const [isbn, info] of allResults) {
      const book = bookIsbnMap.get(isbn)
      if (!book) continue

      const updateData: Record<string, unknown> = {}
      if (info.author && (!book.author || book.author.trim() === '')) {
        updateData.author = info.author
      }
      if (info.publisher && (!book.publisher || book.publisher.trim() === '')) {
        updateData.publisher = info.publisher
      }

      if (Object.keys(updateData).length === 0) continue

      // SNS調査スキップ状態をリセット（再調査可能に）
      if (book.evaluation_reason?.includes('SNS調査スキップ')) {
        updateData.evaluation_reason = null
        // JSONB として正しく空オブジェクトを保存（文字列 "{}" にならないよう注意）
        updateData.sns_data = { _needsRecheck: true }
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
          source: openbdResults.has(isbn) ? 'openBD' : 'GoogleBooks',
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
      foundOpenBD: openbdResults.size,
      foundGoogle: googleResults.size,
      updated,
      resetForSns,
      remaining: remainingCount || 0,
      elapsedMs: Date.now() - startTime,
      results: results.slice(0, 30),
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
