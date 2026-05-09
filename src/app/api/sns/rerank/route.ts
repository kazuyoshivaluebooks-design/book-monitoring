import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import type { SnsData } from '@/lib/supabase'
import { rankBook } from '@/lib/sns/ranker'
import type { YouTubeChannelData } from '@/lib/sns/youtube'
import type { SocialProfile, SearchResultRaw } from '@/lib/sns/social-search'

export const dynamic = 'force-dynamic'
export const maxDuration = 10  // Vercel Hobby plan: max 10s

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const token = request.nextUrl.searchParams.get('token')
    const authHeader = request.headers.get('authorization')
    if (token !== cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicApiKey) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY ãè¨­å®ããã¦ãã¾ãã' },
      { status: 500 }
    )
  }

  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get('limit') || '2', 10),
    5
  )
  const startTime = Date.now()

  try {
    const { data: books, error: fetchError } = await supabase
      .from('books')
      .select('id, title, author, publisher, isbn, price, release_date, sns_data, evaluation_reason')
      .like('evaluation_reason', '%ã«ã¼ã«ãã¼ã¹å¤å®%')
      .order('release_date', { ascending: true, nullsFirst: false })
      .limit(limit)

    if (fetchError) {
      return NextResponse.json(
        { error: `DBåå¾ã¨ã©ã¼: ${fetchError.message}` },
        { status: 500 }
      )
    }

    if (!books || books.length === 0) {
      const remaining = await getRemainingCount()
      return NextResponse.json({
        message: 'ã«ã¼ã«ãã¼ã¹å¤å®ã®æ¸ç±ã¯ãã¹ã¦åå¤å®å®äº',
        processed: 0,
        remaining,
        source: 'sns/rerank',
        timestamp: new Date().toISOString(),
      })
    }

    const results: Array<{
      bookId: string
      title: string
      author: string
      oldRank: string | null
      newRank: string | null
      oldReason: string
      newReason: string
      error?: string
    }> = []

    for (const book of books) {
      if (Date.now() - startTime > 7000) break

      try {
        const snsData: SnsData = book.sns_data || {}

        const youtube = reconstructYouTube(snsData)
        const socialProfiles = reconstructProfiles(snsData)
        const rawSearchResults: SearchResultRaw[] = []

        const rankResult = await rankBook(
          {
            title: book.title,
            author: book.author,
            publisher: book.publisher,
            isbn: book.isbn,
            price: book.price,
            releaseDate: book.release_date,
          },
          youtube,
          socialProfiles,
          rawSearchResults,
          anthropicApiKey
        )

        const newReason = `${rankResult.evaluationReason} [åå¤å®: ã«ã¼ã«ãã¼ã¹âClaude AI]`

        const { error: updateError } = await supabase
          .from('books')
          .update({
            rank: rankResult.rank,
            evaluation_reason: newReason,
          })
          .eq('id', book.id)

        if (updateError) {
          results.push({
            bookId: book.id,
            title: book.title,
            author: book.author,
            oldRank: book.sns_data?.youtube?.subscribers ? 'had-data' : null,
            newRank: rankResult.rank,
            oldReason: book.evaluation_reason || '',
            newReason,
            error: `DBæ´æ°ã¨ã©ã¼: ${updateError.message}`,
          })
        } else {
          results.push({
            bookId: book.id,
            title: book.title,
            author: book.author,
            oldRank: extractOldRank(book.evaluation_reason),
            newRank: rankResult.rank,
            oldReason: book.evaluation_reason || '',
            newReason,
          })
        }
      } catch (e) {
        results.push({
          bookId: book.id,
          title: book.title,
          author: book.author,
          oldRank: null,
          newRank: null,
          oldReason: book.evaluation_reason || '',
          newReason: '',
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    const remaining = await getRemainingCount()

    return NextResponse.json({
      processed: results.length,
      remaining,
      results,
      source: 'sns/rerank',
      elapsedMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : String(e),
        source: 'sns/rerank',
        elapsedMs: Date.now() - startTime,
      },
      { status: 500 }
    )
  }
}

async function getRemainingCount(): Promise<number> {
  const { count } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .like('evaluation_reason', '%ã«ã¼ã«ãã¼ã¹å¤å®%')
  return count || 0
}

function extractOldRank(reason: string | null): string | null {
  if (!reason) return null
  return null
}

function reconstructYouTube(snsData: SnsData): YouTubeChannelData | null {
  if (!snsData.youtube) return null

  return {
    channelId: '',
    channelTitle: '',
    channelUrl: snsData.youtube.url || '',
    subscriberCount: snsData.youtube.subscribers || 0,
    videoCount: 0,
    viewCount: 0,
    recentVideos: [],
  }
}

function reconstructProfiles(snsData: SnsData): SocialProfile[] {
  const profiles: SocialProfile[] = []

  const platformKeys: Array<{
    key: 'x' | 'instagram' | 'facebook' | 'tiktok' | 'voicy' | 'standfm' | 'podcast' | 'note'
    platform: SocialProfile['platform']
  }> = [
    { key: 'x', platform: 'x' },
    { key: 'instagram', platform: 'instagram' },
    { key: 'facebook', platform: 'facebook' },
    { key: 'tiktok', platform: 'tiktok' },
    { key: 'voicy', platform: 'voicy' },
    { key: 'standfm', platform: 'standfm' },
    { key: 'podcast', platform: 'podcast' },
    { key: 'note', platform: 'note' },
  ]

  for (const { key, platform } of platformKeys) {
    const data = snsData[key]
    if (data) {
      profiles.push({
        platform,
        url: data.url || '',
        displayName: null,
        snippet: null,
        estimatedFollowers: data.followers,
      })
    }
  }

  return profiles
}
