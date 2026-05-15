import { NextRequest, NextResponse } from 'next/server'
import { searchSocialProfiles } from '@/lib/sns/social-search'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

/**
 * GET /api/debug/search-test?author=柚木麻子
 *
 * Serper検索の結果を直接確認するデバッグ用エンドポイント
 */
export async function GET(request: NextRequest) {
  const author = request.nextUrl.searchParams.get('author')
  if (!author) {
    return NextResponse.json({ error: 'author parameter required' })
  }

  const start = Date.now()

  const googleApiKey = process.env.GOOGLE_SEARCH_API_KEY
  const googleCx = process.env.GOOGLE_SEARCH_CX

  const { profiles, rawResults } = await searchSocialProfiles(
    author,
    googleApiKey,
    googleCx
  )

  return NextResponse.json({
    author,
    elapsedMs: Date.now() - start,
    serperKey: process.env.SERPER_API_KEY ? 'set' : 'not set',
    braveKey: process.env.BRAVE_SEARCH_API_KEY ? 'set' : 'not set',
    totalResults: rawResults.length,
    profiles: profiles.map(p => ({
      platform: p.platform,
      url: p.url,
      displayName: p.displayName,
      followers: p.estimatedFollowers,
    })),
    rawResults: rawResults.slice(0, 15),
  })
}
