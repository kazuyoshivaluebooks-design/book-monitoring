import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

/**
 * POST /api/sns/recheck
 * ランクなし＋著者名ありの書籍をSNS再調査対象にリセットする
 *
 * Body: { limit?: number } (default: all)
 *
 * sns_data と evaluation_reason をリセットして /api/sns/check で再処理可能にする
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const limit = body.limit || 9999

    const resetAll = body.resetAll === true

    // resetAll: 全書籍を再調査（Claude API修正後の再評価用）
    // 通常: ランクなし＋著者名あり＋調査済みの書籍のみ
    let query = supabase
      .from('books')
      .select('id, title, author, release_date, evaluation_reason')
      .not('author', 'is', null)
      .not('author', 'eq', '')

    if (!resetAll) {
      query = query
        .is('rank', null)
        .not('evaluation_reason', 'is', null)
        .not('evaluation_reason', 'like', '%SNS調査スキップ%')
    } else {
      query = query.not('evaluation_reason', 'is', null)
    }

    const { data: books, error } = await query.limit(limit)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!books || books.length === 0) {
      return NextResponse.json({ message: '再調査対象の書籍はありません', reset: 0 })
    }

    // バッチでリセット
    let reset = 0
    const batchSize = 50
    for (let i = 0; i < books.length; i += batchSize) {
      const batch = books.slice(i, i + batchSize)
      const ids = batch.map(b => b.id)

      const { error: updateError } = await supabase
        .from('books')
        .update({
          evaluation_reason: null,
          sns_data: {},
          rank: null,
        })
        .in('id', ids)

      if (!updateError) {
        reset += batch.length
      }
    }

    // 月別の内訳
    const byMonth: Record<string, number> = {}
    for (const b of books) {
      const month = b.release_date ? b.release_date.slice(0, 7) : 'unknown'
      byMonth[month] = (byMonth[month] || 0) + 1
    }

    return NextResponse.json({
      reset,
      total: books.length,
      byMonth,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
