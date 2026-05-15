import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

/**
 * GET /api/debug/search-test?author=柚木麻子
 *
 * Serper と Brave を両方直接テストして結果を比較
 */
export async function GET(request: NextRequest) {
  const author = request.nextUrl.searchParams.get('author')
  if (!author) {
    return NextResponse.json({ error: 'author parameter required' })
  }

  const serperKey = process.env.SERPER_API_KEY
  const braveKey = process.env.BRAVE_SEARCH_API_KEY
  const results: Record<string, unknown> = { author }

  // Test Serper
  if (serperKey) {
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: `"${author}" site:x.com`, gl: 'jp', hl: 'ja', num: 5 }),
        signal: AbortSignal.timeout(5000),
      })
      const text = await res.text()
      results.serper = {
        status: res.status,
        body: text.slice(0, 500),
      }
    } catch (e) {
      results.serper = { error: String(e) }
    }
  } else {
    results.serper = { error: 'key not set' }
  }

  // Test Brave
  if (braveKey) {
    try {
      const query = `"${author}" (site:x.com OR site:twitter.com OR site:instagram.com OR site:note.com)`
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': braveKey,
        },
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        const data = await res.json()
        const webResults = data.web?.results || []
        results.brave = {
          status: res.status,
          resultCount: webResults.length,
          results: webResults.slice(0, 5).map((r: { title?: string; url?: string; description?: string }) => ({
            title: r.title || '',
            url: r.url || '',
            snippet: (r.description || '').slice(0, 150),
          })),
        }
      } else {
        const text = await res.text()
        results.brave = { status: res.status, body: text.slice(0, 500) }
      }
    } catch (e) {
      results.brave = { error: String(e) }
    }
  } else {
    results.brave = { error: 'key not set' }
  }

  return NextResponse.json(results)
}
