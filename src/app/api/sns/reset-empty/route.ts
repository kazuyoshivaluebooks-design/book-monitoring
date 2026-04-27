import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// GET /api/sns/reset-empty — リセット対象の件数を確認（実行はしない）
export async function GET() {
  const { count, error } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .or('evaluation_reason.ilike.%結果0件%,evaluation_reason.ilike.%結果 0件%')
    .not('author', 'is', null)
    .not('author', 'eq', '')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ resetCandidates: count || 0 })
}

// POST /api/sns/reset-empty
// 検索結果0件だった書籍のevaluation_reasonをnullにリセットし、再調査対象にする
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  // 簡易認証（オプション）
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // same-origin check
    const origin = request.headers.get('origin') || ''
    const referer = request.headers.get('referer') || ''
    const host = request.nextUrl.hostname
    if (!origin.includes(host) && !referer.includes(host)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  // 「結果0件」を含むevaluation_reasonの書籍を検索
  const { data: emptyBooks, error: fetchError } = await supabase
    .from('books')
    .select('id, title, author, evaluation_reason')
    .or('evaluation_reason.ilike.%結果0件%,evaluation_reason.ilike.%結果 0件%')
    .not('author', 'is', null)
    .not('author', 'eq', '')

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 })
  }

  if (!emptyBooks || emptyBooks.length === 0) {
    return NextResponse.json({
      message: 'リセット対象の書籍はありません',
      reset: 0,
    })
  }

  // evaluation_reason を null にリセット
  const ids = emptyBooks.map(b => b.id)

  // Supabaseは一括update with IN が使えないのでバッチで更新
  let resetCount = 0
  const BATCH = 100
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    const { error: updateError } = await supabase
      .from('books')
      .update({ evaluation_reason: null, rank: null, sns_data: null })
      .in('id', batch)

    if (!updateError) {
      resetCount += batch.length
    }
  }

  return NextResponse.json({
    message: `${resetCount}件の書籍をリセットしました（再調査対象になります）`,
    reset: resetCount,
    total: emptyBooks.length,
  })
}
