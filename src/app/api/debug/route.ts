import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  const results: Record<string, unknown> = {
    envCheck: {
      SERPER_API_KEY: process.env.SERPER_API_KEY ? `set (${process.env.SERPER_API_KEY.slice(0, 8)}...)` : 'NOT SET',
      BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY ? `set (${process.env.BRAVE_SEARCH_API_KEY.slice(0, 8)}...)` : 'NOT SET',
      GOOGLE_SEARCH_API_KEY: process.env.GOOGLE_SEARCH_API_KEY ? 'set' : 'NOT SET',
      YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY ? 'set' : 'NOT SET',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? 'set' : 'NOT SET',
    },
  }

  // Serper.dev テスト（Google検索API）
  const serperKey = process.env.SERPER_API_KEY
  if (serperKey) {
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: '"東畑開人" SNS Twitter YouTube Instagram', gl: 'jp', hl: 'ja', num: 10 }),
        signal: AbortSignal.timeout(5000),
      })

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '')
        results.serperTest = { status: res.status, error: errorBody.slice(0, 500) }
      } else {
        const data = await res.json()
        const organic = data.organic || []
        results.serperTest = {
          status: 200,
          resultCount: organic.length,
          knowledgeGraph: data.knowledgeGraph ? { title: data.knowledgeGraph.title, description: (data.knowledgeGraph.description || '').slice(0, 100) } : null,
          results: organic.slice(0, 5).map((r: { title?: string; link?: string; snippet?: string }) => ({
            title: r.title, url: r.link, snippet: (r.snippet || '').slice(0, 100),
          })),
        }
      }
    } catch (e) {
      results.serperTest = { error: e instanceof Error ? e.message : String(e) }
    }
  } else {
    results.serperTest = { error: 'SERPER_API_KEY not set — https://serper.dev/signup で無料取得' }
  }

  const braveKey = process.env.BRAVE_SEARCH_API_KEY
  if (braveKey) {
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent('"佐伯ポインティ" site:youtube.com OR site:x.com')}&count=5`
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': braveKey,
        },
        signal: AbortSignal.timeout(5000),
      })

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '')
        results.braveTest = { status: res.status, statusText: res.statusText, error: errorBody.slice(0, 500) }
      } else {
        const data = await res.json()
        const webResults = data.web?.results || []
        results.braveTest = {
          status: 200,
          resultCount: webResults.length,
          results: webResults.slice(0, 3).map((r: { title?: string; url?: string }) => ({ title: r.title, url: r.url })),
        }
      }
    } catch (e) {
      results.braveTest = { error: e instanceof Error ? e.message : String(e) }
    }
  } else {
    results.braveTest = { error: 'BRAVE_SEARCH_API_KEY not set' }
  }

  // Google CSE テスト
  const googleKey = process.env.GOOGLE_SEARCH_API_KEY
  const googleCx = process.env.GOOGLE_SEARCH_CX
  if (googleKey && googleCx) {
    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${googleKey}&cx=${googleCx}&q=${encodeURIComponent('"佐伯ポインティ"')}&num=5`
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '')
        results.googleCseTest = { status: res.status, error: errorBody.slice(0, 500) }
      } else {
        const data = await res.json()
        const items = data.items || []
        results.googleCseTest = {
          status: 200,
          resultCount: items.length,
          totalResults: data.searchInformation?.totalResults,
          results: items.slice(0, 3).map((r: { title?: string; link?: string; snippet?: string }) => ({
            title: r.title, url: r.link, snippet: (r.snippet || '').slice(0, 100),
          })),
        }
      }
    } catch (e) {
      results.googleCseTest = { error: e instanceof Error ? e.message : String(e) }
    }
  } else {
    results.googleCseTest = { error: `GOOGLE_SEARCH_API_KEY: ${googleKey ? 'set' : 'NOT SET'}, CX: ${googleCx ? 'set' : 'NOT SET'}` }
  }

  return NextResponse.json(results)
}
