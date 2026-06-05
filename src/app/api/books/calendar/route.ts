/**
 * カレンダー用: 月別の日ごと登録数＋ランク内訳
 * GET /api/books/calendar?year=2026&month=6
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const year = parseInt(request.nextUrl.searchParams.get('year') || '', 10)
  const month = parseInt(request.nextUrl.searchParams.get('month') || '', 10)

  if (!year || !month || month < 1 || month > 12) {
    return NextResponse.json({ error: 'year and month required' }, { status: 400 })
  }

  const monthStr = String(month).padStart(2, '0')
  const nextMonth = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`
  const fromDate = `${year}-${monthStr}-01T00:00:00+09:00`
  const toDate = `${nextMonth}-01T00:00:00+09:00`

  // 軽量: id, rank, discovered_at のみ取得
  const allBooks: Array<{ rank: string | null; discovered_at: string }> = []
  const PAGE = 1000
  let from = 0
  let hasMore = true

  while (hasMore) {
    const { data, error } = await supabase
      .from('books')
      .select('rank, discovered_at')
      .gte('discovered_at', fromDate)
      .lt('discovered_at', toDate)
      .range(from, from + PAGE - 1)

    if (error || !data || data.length === 0) {
      hasMore = false
    } else {
      allBooks.push(...data)
      from += data.length
      hasMore = data.length === PAGE
    }
  }

  // JST基準で日ごとに集計
  const days: Record<string, { total: number; high: number; mid: number; watch: number; unranked: number }> = {}

  for (const book of allBooks) {
    const utc = new Date(book.discovered_at)
    const jst = new Date(utc.getTime() + 9 * 60 * 60 * 1000)
    const dateKey = jst.toISOString().split('T')[0]

    if (!days[dateKey]) {
      days[dateKey] = { total: 0, high: 0, mid: 0, watch: 0, unranked: 0 }
    }
    const d = days[dateKey]
    d.total++
    if (book.rank === '高確率') d.high++
    else if (book.rank === '中確率') d.mid++
    else if (book.rank === '注目') d.watch++
    else d.unranked++
  }

  return NextResponse.json({ year, month, totalBooks: allBooks.length, days })
}
