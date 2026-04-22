import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/debug?q=HIKAKIN
 * CSE JSON API の生レスポンスを返すデバッグ用エンドポイント
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q') || 'HIKAKIN'

  const apiKey = process.env.GOOGLE_SEARCH_API_KEY
  const cx = process.env.GOOGLE_SEARCH_CX

  if (!apiKey || !cx) {
    return NextResponse.json({ error: 'Missing env vars', hasApiKey: !!apiKey, hasCx: !!cx })
  }

  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(q)}&num=5`

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const data = await res.json()

    return NextResponse.json({
      query: q,
      cx,
      apiStatus: res.status,
      totalResults: data.searchInformation?.totalResults,
      itemCount: data.items?.length || 0,
      items: (data.items || []).slice(0, 3).map((i: { title?: string; link?: string; snippet?: string }) => ({
        title: i.title,
        link: i.link,
        snippet: (i.snippet || '').slice(0, 100),
      })),
      error: data.error || null,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
