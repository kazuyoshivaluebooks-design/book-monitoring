import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

/**
 * GET /api/sns/reset-zero?minDays=30&dryRun=true
 *
 * 「結果0件」の書籍のうち、発売日がminDays日以上先のものをリセットして再調査対象にする
 * dryRun=true: 件数のみ返す（デフォルト）
 * dryRun=false: 実際にリセットする
 */
export async function GET(request: NextRequest) {
  const minDays = parseInt(request.nextUrl.searchParams.get('minDays') || '30', 10)
  const dryRun = request.nextUrl.searchParams.get('dryRun') !== 'false'

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() + minDays)
  const cutoffStr = cutoffDate.toISOString().split('T')[0]

  if (dryRun) {
    // カウントのみ
    const { count } = await supabase
      .from('books')
      .select('id', { count: 'exact', head: true })
      .like('evaluation_reason', '%結果0件%')
      .gte('release_date', cutoffStr)
      .not('author', 'is', null)
      .neq('author', '')

    return NextResponse.json({
      mode: 'dryRun',
      minDays,
      cutoffDate: cutoffStr,
      targetCount: count || 0,
      estimatedCredits: (count || 0) * 3,
      message: `dryRun=falseで実行するとリセットされます`,
    })
  }

  // 実際にリセット
  const { data, error } = await supabase
    .from('books')
    .update({
      sns_data: '{}',
      rank: null,
      evaluation_reason: '自動検出 - SNS調査待ち',
    })
    .like('evaluation_reason', '%結果0件%')
    .gte('release_date', cutoffStr)
    .not('author', 'is', null)
    .neq('author', '')
    .select('id')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    mode: 'executed',
    minDays,
    cutoffDate: cutoffStr,
    resetCount: data?.length || 0,
    estimatedCredits: (data?.length || 0) * 3,
    message: `${data?.length || 0}件をリセットしました。cronまたはダッシュボードから自動的に再調査されます。`,
  })
}
