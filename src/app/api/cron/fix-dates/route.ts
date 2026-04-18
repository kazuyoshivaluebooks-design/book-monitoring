import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import * as cheerio from 'cheerio'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

// 版元ドットコムの個別ISBNページから発売日を取得
async function fetchReleaseDateFromHanmoto(isbn: string): Promise<string | null> {
  try {
    const url = `https://www.hanmoto.com/bd/isbn/${isbn}`
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return null

    const html = await res.text()
    const $ = cheerio.load(html)
    const dataScript = $('#hanmotocom-data').html()
    if (!dataScript) return null

    const data = JSON.parse(dataScript)
    const book = data?.book?.data?.book
    if (!book) return null

    if (book.dates?.sales) {
      return book.dates.sales.split('T')[0]
    } else if (book.dates?.publish && book.dates.publish.length === 8) {
      const p = book.dates.publish
      return `${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6, 8)}`
    }
    return null
  } catch {
    return null
  }
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const batchSize = parseInt(request.nextUrl.searchParams.get('batch') || '5', 10)

  // 発売日が欠落している書籍を取得（ISBNがあるもの限定）
  const { data: books, error } = await supabase
    .from('books')
    .select('id, isbn, title')
    .is('release_date', null)
    .not('isbn', 'is', null)
    .limit(batchSize)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!books || books.length === 0) {
    return NextResponse.json({ message: '発売日未設定の書籍はありません', updated: 0 })
  }

  const results = {
    checked: 0,
    updated: 0,
    notFound: 0,
    errors: [] as string[],
    updatedBooks: [] as Array<{ title: string; date: string }>,
  }

  for (const book of books) {
    const elapsed = Date.now() - startTime
    if (elapsed > 8000) {
      results.errors.push('タイムアウト間近のため中断')
      break
    }

    if (!book.isbn) continue
    results.checked++

    const releaseDate = await fetchReleaseDateFromHanmoto(book.isbn)
    if (releaseDate) {
      const { error: updateError } = await supabase
        .from('books')
        .update({ release_date: releaseDate })
        .eq('id', book.id)

      if (!updateError) {
        results.updated++
        results.updatedBooks.push({ title: book.title, date: releaseDate })
      } else {
        results.errors.push(`更新エラー: ${book.title}`)
      }
    } else {
      results.notFound++
    }
  }

  return NextResponse.json({
    ...results,
    remaining: (books.length - results.checked),
    elapsedMs: Date.now() - startTime,
  })
}
