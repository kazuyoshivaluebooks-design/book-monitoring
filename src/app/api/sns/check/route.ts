import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { searchYouTubeAuthor } from '@/lib/sns/youtube'
import { searchSocialProfiles, QuotaExhaustedError } from '@/lib/sns/social-search'
import { rankBook } from '@/lib/sns/ranker'

export const dynamic = 'force-dynamic'
export const maxDuration = 10  // Vercel Hobby plan: max 10s

/**
 * POST /api/sns/check
 * 指定された書籍のSNS調査を実行してランク判定する
 *
 * Body: { bookId: string } または { bookIds: string[] }
 *
 * GET /api/sns/check?pending=true&limit=5
 * SNS未調査の書籍を自動取得して一括処理
 */

/**
 * 著者名がSNS調査に不適切かどうかを判定（機関名・委員会等をスキップ）
 * SNS検索APIの呼び出しを節約するためのプレフィルタ
 */
const SKIP_AUTHOR_PATTERNS = [
  /委員会$/, /研究会$/, /研究所$/, /協会$/, /学会$/,
  /事務局$/, /編集部$/, /制作委員会$/, /プロジェクト$/,
  /省$/, /庁$/, /局$/, /課$/, /部会$/,
  /株式会社/, /有限会社/, /合同会社/, /一般社団法人/, /一般財団法人/,
  /^編集/, /制作$/, /事務所$/,
]

function shouldSkipAuthor(authorName: string): boolean {
  return SKIP_AUTHOR_PATTERNS.some(p => p.test(authorName))
}

async function checkSingleBook(bookId: string): Promise<{
  bookId: string
  title: string
  author: string
  rank: string | null
  evaluationReason: string
  error?: string
}> {
  // 書籍情報を取得
  const { data: book, error: fetchError } = await supabase
    .from('books')
    .select('*')
    .eq('id', bookId)
    .single()

  if (fetchError || !book) {
    return {
      bookId,
      title: '不明',
      author: '不明',
      rank: null,
      evaluationReason: '',
      error: `書籍取得エラー: ${fetchError?.message || '見つかりません'}`,
    }
  }

  // 著者名の前処理（"山田太郎／著" → "山田太郎"）
  const rawAuthor = book.author || ''
  const authorName = rawAuthor
    .split(/[／\/,、]/)[0]  // 最初の著者のみ
    .replace(/[（(].*?[）)]/, '')  // 括弧内を除去
    .replace(/(著|編|監修|訳|翻訳|イラスト|写真)$/, '')  // 役割を除去
    .trim()

  if (!authorName) {
    // 著者名なしの場合はスキップ
    await supabase.from('books').update({
      evaluation_reason: 'SNS調査スキップ: 著者名が空',
    }).eq('id', bookId)

    return {
      bookId,
      title: book.title,
      author: rawAuthor,
      rank: null,
      evaluationReason: 'SNS調査スキップ: 著者名が空',
    }
  }

  // 機関名・委員会等はSNS調査をスキップ（API節約）
  if (shouldSkipAuthor(authorName)) {
    await supabase.from('books').update({
      evaluation_reason: `SNS調査スキップ: 機関名（${authorName}）`,
    }).eq('id', bookId)

    return {
      bookId,
      title: book.title,
      author: rawAuthor,
      rank: null,
      evaluationReason: `SNS調査スキップ: 機関名（${authorName}）`,
    }
  }

  // 1. YouTube 調査
  const youtubeApiKey = process.env.YOUTUBE_API_KEY
  const youtube = youtubeApiKey
    ? await searchYouTubeAuthor(authorName, youtubeApiKey)
    : null

  // 2. SNS検索（汎用検索2回 → URL判別 + 生データをClaudeに渡す）
  const googleSearchApiKey = process.env.GOOGLE_SEARCH_API_KEY
  const googleSearchCx = process.env.GOOGLE_SEARCH_CX
  const { profiles: socialProfiles, rawResults } = await searchSocialProfiles(
    authorName,
    googleSearchApiKey,
    googleSearchCx
  )

  // 3. Claude API でランク判定
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicApiKey) {
    return {
      bookId,
      title: book.title,
      author: rawAuthor,
      rank: null,
      evaluationReason: 'ANTHROPIC_API_KEY が設定されていません',
      error: 'ANTHROPIC_API_KEY 未設定',
    }
  }

  const rankResult = await rankBook(
    {
      title: book.title,
      author: rawAuthor,
      publisher: book.publisher,
      isbn: book.isbn,
      price: book.price,
      releaseDate: book.release_date,
    },
    youtube,
    socialProfiles,
    rawResults,
    anthropicApiKey
  )

  // デバッグ: 検索結果の詳細をevaluation_reasonに追加
  if (rawResults.length > 0) {
    const debugInfo = rawResults.slice(0, 3).map(r => `[${r.title}](${r.url})`).join('; ')
    rankResult.evaluationReason += ` [検索ヒット${rawResults.length}件: ${debugInfo.slice(0, 200)}]`
  } else {
    rankResult.evaluationReason += ' [検索: 結果0件]'
  }

  // 4. Supabase を更新
  // sns_data が空の場合でも「調査済み」マーカーを付与して再処理を防止
  const finalSnsData = Object.keys(rankResult.snsData).length === 0
    ? { _checked: true, _checkedAt: new Date().toISOString() }
    : { ...rankResult.snsData, _checkedAt: new Date().toISOString() }

  const { error: updateError } = await supabase
    .from('books')
    .update({
      rank: rankResult.rank,
      sns_data: finalSnsData,
      evaluation_reason: rankResult.evaluationReason,
    })
    .eq('id', bookId)

  if (updateError) {
    return {
      bookId,
      title: book.title,
      author: rawAuthor,
      rank: rankResult.rank,
      evaluationReason: rankResult.evaluationReason,
      error: `DB更新エラー: ${updateError.message}`,
    }
  }

  return {
    bookId,
    title: book.title,
    author: rawAuthor,
    rank: rankResult.rank,
    evaluationReason: rankResult.evaluationReason,
  }
}

// POST: 特定の書籍を調査
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const bookIds: string[] = body.bookIds || (body.bookId ? [body.bookId] : [])

    if (bookIds.length === 0) {
      return NextResponse.json({ error: 'bookId または bookIds が必要です' }, { status: 400 })
    }

    const results = []
    for (const id of bookIds) {
      const result = await checkSingleBook(id)
      results.push(result)
    }

    return NextResponse.json({ results })
  } catch (e) {
    if (e instanceof QuotaExhaustedError) {
      return NextResponse.json(
        { error: e.message, quotaExhausted: true, processed: 0, remaining: -1 },
        { status: 429 }
      )
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}

/**
 * 未調査書籍の残数を取得
 */
async function getPendingCount(): Promise<number> {
  const { count } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .or('evaluation_reason.is.null,evaluation_reason.eq.自動検出 - SNS調査待ち')
    .not('author', 'is', null)
    .not('author', 'eq', '')
  return count || 0
}


// GET: 未調査の書籍を処理（cron / 外部cron / ダッシュボード自動呼び出し）
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const limit = parseInt(searchParams.get('limit') || '3', 10)

  // ※ このエンドポイントはダッシュボードから直接呼ばれるため認証なし
  // 外部cronサービスからは /api/cron/sns-batch 経由で呼び出す（認証付き）

  try {
    // SNS未調査の書籍を取得
    const { data: pendingBooks, error } = await supabase
      .from('books')
      .select('id, title, author, evaluation_reason')
      .or('evaluation_reason.is.null,evaluation_reason.eq.自動検出 - SNS調査待ち')
      .not('author', 'is', null)
      .not('author', 'eq', '')
      .order('release_date', { ascending: true, nullsFirst: false })
      .limit(Math.min(limit, 10))

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!pendingBooks || pendingBooks.length === 0) {
      const remaining = await getPendingCount()
      return NextResponse.json({
        message: 'SNS未調査の書籍はありません（全件処理完了）',
        processed: 0,
        remaining,
      })
    }

    const startTime = Date.now()
    const results: Array<{ bookId?: string; title?: string; author?: string; rank?: string | null; evaluationReason?: string; error?: string }> = []

    // Hobby plan: 1冊ずつ順次処理（タイムアウト回避）
    for (const book of pendingBooks) {
      if (Date.now() - startTime > 7000) break  // 7秒で打ち切り（10秒制限に余裕）

      try {
        const result = await checkSingleBook(book.id)
        results.push(result)
      } catch (e) {
        if (e instanceof QuotaExhaustedError) {
          // クォータ切れ — 処理済み分と一緒に返す
          const remaining = await getPendingCount()
          return NextResponse.json({
            processed: results.length,
            remaining,
            results,
            quotaExhausted: true,
            quotaError: e.message,
            elapsedMs: Date.now() - startTime,
          })
        }
        results.push({ bookId: book.id, error: String(e) })
      }
    }

    const remaining = await getPendingCount()

    return NextResponse.json({
      processed: results.length,
      remaining,
      results,
      elapsedMs: Date.now() - startTime,
    })
  } catch (e) {
    if (e instanceof QuotaExhaustedError) {
      return NextResponse.json(
        { error: e.message, quotaExhausted: true, processed: 0 },
        { status: 429 }
      )
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
