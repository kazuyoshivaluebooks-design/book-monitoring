import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { searchYouTubeAuthor } from '@/lib/sns/youtube'
import { searchSocialProfiles } from '@/lib/sns/social-search'
import { rankBook } from '@/lib/sns/ranker'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/sns/check
 * 指定された書籍のSNS調査を実行してランク判定する
 *
 * Body: { bookId: string } または { bookIds: string[] }
 *
 * GET /api/sns/check?pending=true&limit=5
 * SNS未調査の書籍を自動取得して一括処理
 */

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

  // 1. YouTube 調査
  const youtubeApiKey = process.env.YOUTUBE_API_KEY
  const youtube = youtubeApiKey
    ? await searchYouTubeAuthor(authorName, youtubeApiKey)
    : null

  // 2. X/Instagram/Facebook 調査
  const googleSearchApiKey = process.env.GOOGLE_SEARCH_API_KEY
  const googleSearchCx = process.env.GOOGLE_SEARCH_CX
  const socialProfiles = await searchSocialProfiles(
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
    anthropicApiKey
  )

  // 4. Supabase を更新
  const { error: updateError } = await supabase
    .from('books')
    .update({
      rank: rankResult.rank,
      sns_data: rankResult.snsData,
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
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}

// GET: 未調査の書籍を自動処理
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const limit = parseInt(searchParams.get('limit') || '5', 10)

  // cron認証
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // 認証なしの場合は limit を 1 に制限（手動テスト用）
    // return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // SNS未調査（evaluation_reason に 'SNS調査待ち' を含む or rank が null で sns_data が空）の書籍を取得
    const { data: pendingBooks, error } = await supabase
      .from('books')
      .select('id, title, author')
      .is('rank', null)
      .eq('evaluation_reason', '自動検出 - SNS調査待ち')
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, 10))  // 最大10件まで

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!pendingBooks || pendingBooks.length === 0) {
      return NextResponse.json({
        message: 'SNS未調査の書籍はありません',
        processed: 0,
      })
    }

    const startTime = Date.now()
    const results = []

    for (const book of pendingBooks) {
      // Vercel の実行時間制限を考慮（残り時間が少なければ中断）
      if (Date.now() - startTime > 8000) {
        break  // 8秒経過で中断（Hobby Plan 10秒制限のバッファ）
      }
      const result = await checkSingleBook(book.id)
      results.push(result)
    }

    return NextResponse.json({
      processed: results.length,
      remaining: pendingBooks.length - results.length,
      results,
      elapsedMs: Date.now() - startTime,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
