import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/debug?q=HIKAKIN
 * 検索APIの生レスポンスを返すデバッグ用エンドポイント
 * Brave → SearXNG → Google CSE の優先順
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q') || 'HIKAKIN'

  const braveApiKey = process.env.BRAVE_SEARCH_API_KEY
  const searxngRaw = process.env.SEARXNG_ENABLED
  const searxngEnabled = searxngRaw === 'true'
  const googleApiKey = process.env.GOOGLE_SEARCH_API_KEY
  const cx = process.env.GOOGLE_SEARCH_CX

  // デバッグ: 環境変数の状態
  const envStatus = {
    hasBraveKey: !!braveApiKey,
    searxngRaw,
    searxngEnabled,
    hasGoogleKey: !!googleApiKey,
    hasCx: !!cx,
  }

  // 1. Brave Search API
  if (braveApiKey) {
    const snsQuery = `"${q}" site:x.com OR site:instagram.com OR site:youtube.com OR site:tiktok.com OR site:note.com`
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(snsQuery)}&count=10`

    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': braveApiKey,
        },
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json()
      return NextResponse.json({
        engine: 'brave',
        query: snsQuery,
        apiKeyPrefix: braveApiKey.slice(0, 10) + '...',
        apiStatus: res.status,
        totalResults: data.web?.results?.length || 0,
        items: (data.web?.results || []).slice(0, 5).map((r: { title?: string; url?: string; description?: string }) => ({
          title: r.title, link: r.url, snippet: (r.description || '').slice(0, 150),
        })),
        error: data.error || null,
      })
    } catch (e) {
      return NextResponse.json({ engine: 'brave', error: String(e) }, { status: 500 })
    }
  }

  // 2. SearXNG
  if (searxngEnabled) {
    const snsQuery = `"${q}" site:x.com OR site:instagram.com OR site:youtube.com OR site:tiktok.com OR site:note.com`
    const instances = [
      'https://search.ononoki.org',
      'https://searx.tiekoetter.com',
      'https://searx.be',
    ]

    for (const instance of instances) {
      try {
        const url = `${instance}/search?q=${encodeURIComponent(snsQuery)}&format=json&categories=general&language=ja`
        const res = await fetch(url, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'BookMonitoring/1.0' },
          signal: AbortSignal.timeout(10000),
        })
        if (!res.ok) continue

        const data = await res.json()
        return NextResponse.json({
          engine: 'searxng',
          envStatus,
          instance,
          query: snsQuery,
          apiStatus: res.status,
          totalResults: data.results?.length || 0,
          items: (data.results || []).slice(0, 5).map((r: { title?: string; url?: string; content?: string }) => ({
            title: r.title, link: r.url, snippet: (r.content || '').slice(0, 150),
          })),
        })
      } catch {
        continue
      }
    }
    return NextResponse.json({ engine: 'searxng', error: 'All instances failed' }, { status: 500 })
  }

  // 3. Google CSE
  if (googleApiKey && cx) {
    const url = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${cx}&q=${encodeURIComponent(q)}&num=5`
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      const data = await res.json()
      return NextResponse.json({
        engine: 'google',
        envStatus,
        query: q, cx,
        apiKeyPrefix: googleApiKey.slice(0, 10) + '...',
        apiStatus: res.status,
        totalResults: data.searchInformation?.totalResults,
        itemCount: data.items?.length || 0,
        items: (data.items || []).slice(0, 3).map((i: { title?: string; link?: string; snippet?: string }) => ({
          title: i.title, link: i.link, snippet: (i.snippet || '').slice(0, 100),
        })),
        error: data.error || null,
      })
    } catch (e) {
      return NextResponse.json({ engine: 'google', error: String(e) }, { status: 500 })
    }
  }

  return NextResponse.json({
    error: 'No search API configured',
    hasBraveKey: !!braveApiKey,
    searxngEnabled,
    hasGoogleKey: !!googleApiKey,
    hasCx: !!cx,
    hint: 'Set SEARXNG_ENABLED=true for free search (no API key needed)',
  })
}
