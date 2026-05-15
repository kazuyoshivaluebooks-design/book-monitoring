import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/debug/audit?date=2026-05-14
 *
 * 指定日に検出された書籍を「調査対象」「調査対象外（スキップ）」に分類して出力。
 * 精度確認用の一時エンドポイント。
 */
export async function GET(request: NextRequest) {
  const dateParam = request.nextUrl.searchParams.get('date')

  // dateが指定されていない場合は利用可能な日付一覧を返す
  if (!dateParam) {
    const { data: dates } = await supabase
      .from('books')
      .select('discovered_at')
      .order('discovered_at', { ascending: false })
      .limit(5000)

    // 日付ごとにカウント
    const dayCounts = new Map<string, number>()
    for (const row of dates || []) {
      const day = row.discovered_at?.split('T')[0]
      if (day) dayCounts.set(day, (dayCounts.get(day) || 0) + 1)
    }
    const sortedDays = Array.from(dayCounts.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 14)

    return NextResponse.json({
      usage: '/api/debug/audit?date=2026-05-14',
      availableDates: sortedDays.map(([date, count]) => ({ date, count })),
    })
  }

  const dateStr = dateParam

  // 指定日に discovered_at された全書籍を取得（ページネーション）
  const allBooks: Array<{
    id: string; title: string; author: string; publisher: string | null
    isbn: string | null; release_date: string | null; rank: string | null
    evaluation_reason: string | null; sns_data: Record<string, unknown> | null
    discovered_at: string
  }> = []
  const PAGE = 1000
  let from = 0
  let hasMore = true
  while (hasMore) {
    const { data: page } = await supabase
      .from('books')
      .select('id, title, author, publisher, isbn, release_date, rank, evaluation_reason, sns_data, discovered_at')
      .gte('discovered_at', `${dateStr}T00:00:00`)
      .lt('discovered_at', `${dateStr}T23:59:59.999`)
      .range(from, from + PAGE - 1)
    if (page && page.length > 0) {
      allBooks.push(...page)
      from += page.length
      hasMore = page.length === PAGE
    } else {
      hasMore = false
    }
  }

  // 分類
  const investigated: typeof allBooks = []    // 調査対象（SNS調査実行済み）
  const skippedInstitutional: typeof allBooks = []  // 機関名スキップ
  const skippedEmpty: typeof allBooks = []    // 著者名なしスキップ
  const skippedNoResult: typeof allBooks = [] // 調査したが結果0件
  const ranked: typeof allBooks = []          // ランク付き
  const pending: typeof allBooks = []         // 未調査

  for (const book of allBooks) {
    const reason = book.evaluation_reason || ''

    if (!reason || reason === '自動検出 - SNS調査待ち') {
      pending.push(book)
    } else if (reason.includes('スキップ') && reason.includes('機関名')) {
      skippedInstitutional.push(book)
    } else if (reason.includes('スキップ') && reason.includes('著者名が空')) {
      skippedEmpty.push(book)
    } else if (reason.includes('結果0件') || reason.includes('結果 0件')) {
      skippedNoResult.push(book)
    } else {
      investigated.push(book)
      if (book.rank) ranked.push(book)
    }
  }

  // SNSタグ情報のサマリ
  const formatBook = (b: typeof allBooks[0]) => {
    const snsKeys = b.sns_data ? Object.keys(b.sns_data).filter(k => !k.startsWith('_')) : []
    return {
      title: b.title,
      author: b.author,
      publisher: b.publisher,
      release_date: b.release_date,
      rank: b.rank,
      reason: (b.evaluation_reason || '').slice(0, 250),
      snsFound: snsKeys,
    }
  }

  return NextResponse.json({
    date: dateStr,
    summary: {
      total: allBooks.length,
      investigated: investigated.length,
      ranked: ranked.length,
      skippedInstitutional: skippedInstitutional.length,
      skippedEmptyAuthor: skippedEmpty.length,
      skippedNoResult: skippedNoResult.length,
      pending: pending.length,
    },
    // ランク付き書籍（精度確認の主対象）
    rankedBooks: ranked.map(formatBook),
    // 調査済みだがランクなし（全件）
    investigatedNoRank: investigated.filter(b => !b.rank).map(formatBook),
    // 機関名スキップ（全件、正しくスキップされているか確認）
    skippedInstitutional: skippedInstitutional.map(b => ({
      title: b.title,
      author: b.author,
      reason: (b.evaluation_reason || '').slice(0, 100),
    })),
    // 著者名なしスキップ
    skippedEmptyAuthor: skippedEmpty.map(b => ({
      title: b.title,
      author: b.author,
    })),
    // 結果0件（全件）
    skippedNoResult: skippedNoResult.map(formatBook),
    // 未調査（全件）
    pending: pending.map(b => ({
      title: b.title,
      author: b.author,
      publisher: b.publisher,
    })),
  })
}
