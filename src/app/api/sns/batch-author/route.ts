import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { searchSocialProfiles, extractYouTubeUrls, QuotaExhaustedError } from '@/lib/sns/social-search'
import { getYouTubeChannelByUrl } from '@/lib/sns/youtube'
import { rankBook } from '@/lib/sns/ranker'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

/**
 * 著者単位バッチ処理エンドポイント
 *
 * GET /api/sns/batch-author
 *   「結果0件」書籍のユニーク著者を分析（機関名除外・重複除外）
 *
 * POST /api/sns/batch-author
 *   Body: { limit?: number, resetFirst?: boolean }
 *   著者単位でバッチ処理（1著者1検索→同著者の全書籍に適用）
 */

const SKIP_AUTHOR_PATTERNS = [
  /委員会$/, /研究会$/, /研究所$/, /協会$/, /学会$/,
  /事務局$/, /編集部$/, /制作委員会$/, /プロジェクト$/,
  /省$/, /庁$/, /局$/, /課$/, /部会$/,
  /株式会社/, /有限会社/, /合同会社/, /一般社団法人/, /一般財団法人/,
  /^編集/, /制作$/, /事務所$/,
  /センター$/, /総合研究所/, /支援センター/,
]

/** 出版社名・組織名・不明著者を直接除外 */
const SKIP_AUTHOR_EXACT = new Set([
  '講談社', '晋遊舎', '旺文社', 'Ｇａｋｋｅｎ', 'Gakken',
  'アンソロジー', '未定', '地球の歩き方編集室',
  'いとう総研資格取得支援センター',
])

function shouldSkipAuthor(authorName: string): boolean {
  if (SKIP_AUTHOR_EXACT.has(authorName)) return true
  return SKIP_AUTHOR_PATTERNS.some(p => p.test(authorName))
}

/** 著者名の正規化（"山田太郎／著" → "山田太郎"） */
function normalizeAuthor(raw: string): string {
  return raw
    .split(/[／\/,、]/)[0]
    .replace(/[（(].*?[）)]/, '')
    .replace(/(著|編|監修|訳|翻訳|イラスト|写真)$/, '')
    .trim()
}

// ─── GET: 分析 ───
export async function GET() {
  // 「結果0件」の書籍を全取得（author, id のみ）
  // 5月中発売の書籍は間に合わない可能性が高いので除外
  // Supabaseのデフォルト制限1000行を超えるためページネーションで全件取得
  const allBooks: Array<{ id: string; author: string; release_date: string | null }> = []
  const PAGE_SIZE = 1000
  let from = 0
  let hasMore = true
  let fetchError: { message: string } | null = null

  while (hasMore) {
    const { data: page, error: pageError } = await supabase
      .from('books')
      .select('id, author, release_date')
      .or('evaluation_reason.ilike.%結果0件%,evaluation_reason.ilike.%結果 0件%')
      .not('evaluation_reason', 'ilike', '%ヒットなし%')
      .not('evaluation_reason', 'ilike', '%検索ヒット%')
      .not('author', 'is', null)
      .not('author', 'eq', '')
      .range(from, from + PAGE_SIZE - 1)

    if (pageError) {
      fetchError = pageError
      break
    }
    if (page && page.length > 0) {
      allBooks.push(...page)
      from += page.length
      hasMore = page.length === PAGE_SIZE
    } else {
      hasMore = false
    }
  }

  const books = allBooks
  const error = fetchError

  // 5月中の発売日の書籍を除外
  const filteredBooks = (books || []).filter(b => {
    if (!b.release_date) return true  // 発売日不明は残す
    const rd = b.release_date as string
    return !(rd >= '2026-05-01' && rd <= '2026-05-31')
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const mayExcluded = (books || []).length - filteredBooks.length

  // 著者名を正規化してグルーピング
  const authorMap = new Map<string, { bookCount: number; bookIds: string[]; rawNames: Set<string> }>()
  let skipCount = 0
  let emptyCount = 0

  for (const book of filteredBooks) {
    const normalized = normalizeAuthor(book.author || '')

    if (!normalized) {
      emptyCount++
      continue
    }

    if (shouldSkipAuthor(normalized)) {
      skipCount++
      continue
    }

    const existing = authorMap.get(normalized)
    if (existing) {
      existing.bookCount++
      existing.bookIds.push(book.id)
      existing.rawNames.add(book.author || '')
    } else {
      authorMap.set(normalized, {
        bookCount: 1,
        bookIds: [book.id],
        rawNames: new Set([book.author || '']),
      })
    }
  }

  // 統計
  const uniqueAuthors = authorMap.size
  const totalBooks = Array.from(authorMap.values()).reduce((sum, a) => sum + a.bookCount, 0)
  const multiBookAuthors = Array.from(authorMap.entries())
    .filter(([, v]) => v.bookCount > 1)
    .sort((a, b) => b[1].bookCount - a[1].bookCount)

  return NextResponse.json({
    totalZeroResultBooks: (books || []).length,
    excludedMayRelease: mayExcluded,
    afterExclusion: filteredBooks.length,
    skippedInstitutional: skipCount,
    skippedEmptyAuthor: emptyCount,
    uniqueAuthorsToSearch: uniqueAuthors,
    totalBooksToProcess: totalBooks,
    savedQueries: totalBooks - uniqueAuthors,
    multiBookAuthors: multiBookAuthors.slice(0, 20).map(([name, v]) => ({
      author: name,
      bookCount: v.bookCount,
    })),
    estimatedSerperQueries: uniqueAuthors,
    freeQuotaRemaining: `2500 - ${uniqueAuthors} = ${2500 - uniqueAuthors}`,
  })
}

// ─── POST: 著者単位バッチ処理 ───
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const limit = body.limit || 5  // デフォルト5著者/リクエスト
  const resetFirst = body.resetFirst !== false  // デフォルトtrue

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicApiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY未設定' }, { status: 500 })
  }

  const googleSearchApiKey = process.env.GOOGLE_SEARCH_API_KEY
  const googleSearchCx = process.env.GOOGLE_SEARCH_CX
  const youtubeApiKey = process.env.YOUTUBE_API_KEY

  // 1. 「結果0件」の書籍を取得
  const { data: books, error } = await supabase
    .from('books')
    .select('id, title, author, publisher, isbn, price, release_date, evaluation_reason')
    .or('evaluation_reason.ilike.%結果0件%,evaluation_reason.ilike.%結果 0件%')
    .not('evaluation_reason', 'ilike', '%ヒットなし%')
    .not('evaluation_reason', 'ilike', '%検索ヒット%')
    .not('author', 'is', null)
    .not('author', 'eq', '')
    .limit(500)  // 十分な量を取得してからグルーピング

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!books || books.length === 0) {
    return NextResponse.json({ message: '処理対象なし', processed: 0 })
  }

  // 5月中発売の書籍を除外
  const filteredBooks = books.filter(b => {
    if (!b.release_date) return true
    const rd = b.release_date as string
    return !(rd >= '2026-05-01' && rd <= '2026-05-31')
  })

  if (filteredBooks.length === 0) {
    return NextResponse.json({ message: '処理対象なし（5月発売除外後）', processed: 0 })
  }

  // 2. 著者名でグルーピング（機関名除外）
  const authorGroups = new Map<string, typeof books>()
  for (const book of filteredBooks) {
    const normalized = normalizeAuthor(book.author || '')
    if (!normalized || shouldSkipAuthor(normalized)) continue

    const existing = authorGroups.get(normalized)
    if (existing) {
      existing.push(book)
    } else {
      authorGroups.set(normalized, [book])
    }
  }

  // 3. limit数の著者を処理
  const startTime = Date.now()
  const authorEntries = Array.from(authorGroups.entries()).slice(0, limit)
  const results: Array<{
    author: string
    booksUpdated: number
    rank: string | null
    searchHits: number
    error?: string
  }> = []

  for (const [authorName, authorBooks] of authorEntries) {
    if (Date.now() - startTime > 7000) break  // 7秒で打ち切り

    try {
      // 1回の検索で著者のSNS情報を取得
      const { profiles: socialProfiles, rawResults } = await searchSocialProfiles(
        authorName, googleSearchApiKey, googleSearchCx
      )

      // YouTube: 検索結果からチャンネルURLを抽出
      let youtube = null
      if (youtubeApiKey && rawResults.length > 0) {
        const ytUrls = extractYouTubeUrls(rawResults)
        for (const ytUrl of ytUrls.slice(0, 2)) {
          const channelData = await getYouTubeChannelByUrl(ytUrl, youtubeApiKey)
          if (channelData && channelData.subscriberCount > 0) {
            youtube = channelData
            break
          }
        }
      }

      // 代表書籍でClaudeランク判定（1著者1回）
      const repBook = authorBooks[0]
      const rankResult = await rankBook(
        {
          title: repBook.title,
          author: repBook.author || '',
          publisher: repBook.publisher,
          isbn: repBook.isbn,
          price: repBook.price,
          releaseDate: repBook.release_date,
        },
        youtube,
        socialProfiles,
        rawResults,
        anthropicApiKey
      )

      // 検索結果情報を追記
      let evalReason = rankResult.evaluationReason
      if (rawResults.length > 0) {
        const debugInfo = rawResults.slice(0, 3).map(r => `[${r.title}](${r.url})`).join('; ')
        evalReason += ` [検索ヒット${rawResults.length}件: ${debugInfo.slice(0, 200)}]`
      } else {
        evalReason += ' [検索: ヒットなし]'
      }

      const finalSnsData = Object.keys(rankResult.snsData).length === 0
        ? { _checked: true, _checkedAt: new Date().toISOString() }
        : { ...rankResult.snsData, _checkedAt: new Date().toISOString() }

      // 同著者の全書籍に適用
      const bookIds = authorBooks.map(b => b.id)
      const BATCH = 50
      for (let i = 0; i < bookIds.length; i += BATCH) {
        const batch = bookIds.slice(i, i + BATCH)
        await supabase
          .from('books')
          .update({
            rank: rankResult.rank,
            sns_data: finalSnsData,
            evaluation_reason: evalReason,
          })
          .in('id', batch)
      }

      results.push({
        author: authorName,
        booksUpdated: bookIds.length,
        rank: rankResult.rank,
        searchHits: rawResults.length,
      })
    } catch (e) {
      if (e instanceof QuotaExhaustedError) {
        return NextResponse.json({
          processed: results.length,
          results,
          quotaExhausted: true,
          error: e.message,
          elapsedMs: Date.now() - startTime,
        }, { status: 429 })
      }
      results.push({
        author: authorName,
        booksUpdated: 0,
        rank: null,
        searchHits: 0,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // 残りの著者数を概算
  const remainingAuthors = authorGroups.size - results.length

  return NextResponse.json({
    processed: results.length,
    totalBooksUpdated: results.reduce((sum, r) => sum + r.booksUpdated, 0),
    remainingAuthors,
    results,
    elapsedMs: Date.now() - startTime,
  })
}
