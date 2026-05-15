import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

/**
 * GET /api/debug/search-test?author=柚木麻子
 *
 * Serper検索の各クエリ結果を個別に確認するデバッグ用エンドポイント
 */
export async function GET(request: NextRequest) {
  const author = request.nextUrl.searchParams.get('author')
  if (!author) {
    return NextResponse.json({ error: 'author parameter required' })
  }

  const serperApiKey = process.env.SERPER_API_KEY
  if (!serperApiKey) {
    return NextResponse.json({ error: 'SERPER_API_KEY not set' })
  }

  const queries = [
    `"${author}" (site:x.com OR site:twitter.com OR site:instagram.com OR site:note.com OR site:facebook.com)`,
    `"${author}" (site:youtube.com OR site:tiktok.com OR site:voicy.jp OR site:stand.fm OR site:podcasts.apple.com OR site:open.spotify.com)`,
    `"${author}" SNS OR Twitter OR YouTube OR Instagram OR フォロワー`,
  ]

  const queryResults: Array<{
    query: string
    status: number | string
    resultCount: number
    results: Array<{ title: string; link: string; snippet: string }>
    error?: string
    knowledgeGraph?: unknown
  }> = []

  for (let i = 0; i < queries.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 200))

    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': serperApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: queries[i],
          gl: 'jp',
          hl: 'ja',
          num: 10,
        }),
        signal: AbortSignal.timeout(5000),
      })

      const status = res.status
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        queryResults.push({
          query: queries[i],
          status,
          resultCount: 0,
          results: [],
          error: `HTTP ${status}: ${text.slice(0, 500)}`,
        })
        continue
      }

      const data = await res.json()
      const organic = data.organic || []

      queryResults.push({
        query: queries[i],
        status,
        resultCount: organic.length,
        results: organic.slice(0, 5).map((item: { title?: string; link?: string; snippet?: string }) => ({
          title: item.title || '',
          link: item.link || '',
          snippet: (item.snippet || '').slice(0, 200),
        })),
        knowledgeGraph: data.knowledgeGraph || null,
      })
    } catch (e) {
      queryResults.push({
        query: queries[i],
        status: 'error',
        resultCount: 0,
        results: [],
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const totalResults = queryResults.reduce((sum, q) => sum + q.resultCount, 0)

  return NextResponse.json({
    author,
    serperKeyPrefix: serperApiKey.slice(0, 8) + '...',
    totalResults,
    queries: queryResults,
  })
}
