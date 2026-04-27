import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import * as cheerio from 'cheerio'

export const dynamic = 'force-dynamic'
export const maxDuration = 10 // Vercel Hobby: 10s

// 版元ドットコムの個別ISBNページから書籍詳細を取得
async function fetchBookDetail(isbn: string): Promise<{
  title: string
  author: string
  publisher: string
  releaseDate: string | null
  price: number | null
} | null> {
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

    // タイトル
    const title = $('span[itemprop="name"]').first().text().trim()
      || $('h1').first().text().trim()
    if (!title) return null

    // 著者
    const author = $('span[itemprop="author"]').map((_, el) => $(el).text().trim()).get().join(' ')
      || ''

    // 出版社
    const publisher = $('span[itemprop="publisher"]').first().text().trim()
      || ''

    // 発売日
    let releaseDate: string | null = null
    const salesEl = $('dd.book-dates-sales')
    if (salesEl.length > 0) {
      const content = salesEl.attr('content')
      if (content && /^\d{4}-\d{2}-\d{2}$/.test(content)) {
        releaseDate = content
      } else {
        const text = salesEl.text().trim()
        const match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
        if (match) {
          releaseDate = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
        }
      }
    }
    if (!releaseDate) {
      const dateEl = $('[itemprop="datePublished"]')
      const content = dateEl.attr('content')
      if (content && /^\d{4}-\d{2}-\d{2}$/.test(content)) {
        releaseDate = content
      }
    }

    // 価格
    const priceText = $('span[itemprop="price"]').attr('content') || $('span[itemprop="price"]').text()
    const price = priceText ? parseInt(priceText.replace(/[^\d]/g, ''), 10) || null : null

    return { title, author, publisher, releaseDate, price }
  } catch {
    return null
  }
}

// ジャンル除外判定（monitorと同じロジック）
const EXCLUDED_KEYWORDS = [
  'コミック', '漫画', 'まんが', 'マンガ', 'ライトノベル',
  '写真集', 'グラビア', '児童書', '雑誌', 'ムック',
  '学習参考書', '問題集', 'ドリル', 'アダルト', 'BL', 'TL',
  'ボーイズラブ', 'ティーンズラブ', 'ゲーム攻略',
  'ぬりえ', 'パズル', 'クロスワード', '楽譜',
]

function shouldExcludeByTitle(title: string): boolean {
  const text = title.toLowerCase()
  return EXCLUDED_KEYWORDS.some(kw => text.includes(kw.toLowerCase()))
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const batchSize = parseInt(request.nextUrl.searchParams.get('batch') || '20', 10)

  // 詳細未取得の書籍を取得（古い順に処理）
  const { data: books, error } = await supabase
    .from('books')
    .select('id, isbn, title, discovered_at')
    .eq('source', '版元ドットコム(詳細未取得)')
    .not('isbn', 'is', null)
    .order('discovered_at', { ascending: true })
    .limit(batchSize)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!books || books.length === 0) {
    return NextResponse.json({
      message: '詳細補完待ちの書籍はありません',
      enriched: 0,
      remaining: 0,
    })
  }

  // 残件数を取得（並列で）
  const countPromise = supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .eq('source', '版元ドットコム(詳細未取得)')

  const results = {
    checked: 0,
    enriched: 0,
    excluded: 0,
    failed: 0,
    errors: [] as string[],
    enrichedBooks: [] as Array<{ isbn: string; title: string; author: string }>,
  }

  // 並列で詳細取得（最大5件ずつ、版元サーバー負荷を考慮）
  const CONCURRENCY = 5
  for (let i = 0; i < books.length; i += CONCURRENCY) {
    const elapsed = Date.now() - startTime
    if (elapsed > 7500) {
      results.errors.push('タイムアウト間近のため中断')
      break
    }

    const chunk = books.slice(i, i + CONCURRENCY)
    const detailResults = await Promise.allSettled(
      chunk.map(book => fetchBookDetail(book.isbn!))
    )

    for (let j = 0; j < chunk.length; j++) {
      const book = chunk[j]
      const result = detailResults[j]
      results.checked++

      if (result.status !== 'fulfilled' || !result.value) {
        results.failed++
        // 取得失敗してもリトライ可能にするため source はそのまま
        continue
      }

      const detail = result.value

      // タイトルで除外判定
      if (shouldExcludeByTitle(detail.title)) {
        // 除外ジャンルの書籍はDBから削除
        await supabase.from('books').delete().eq('id', book.id)
        results.excluded++
        continue
      }

      // 詳細で更新
      const { error: updateError } = await supabase
        .from('books')
        .update({
          title: detail.title,
          author: detail.author,
          publisher: detail.publisher,
          release_date: detail.releaseDate,
          price: detail.price,
          source: '版元ドットコム',
          evaluation_reason: null,
        })
        .eq('id', book.id)

      if (updateError) {
        results.errors.push(`更新エラー (${book.isbn}): ${updateError.message}`)
        results.failed++
      } else {
        results.enriched++
        results.enrichedBooks.push({
          isbn: book.isbn!,
          title: detail.title,
          author: detail.author,
        })
      }
    }
  }

  const countResult = await countPromise
  const remaining = (countResult.count ?? 0) - results.enriched - results.excluded

  return NextResponse.json({
    ...results,
    remaining: Math.max(0, remaining),
    elapsedMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  })
}
