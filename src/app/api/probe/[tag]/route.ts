import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

/**
 * GET /api/probe/{tag}
 *
 * キャッシュ回避用の軽量ステータス確認エンドポイント。
 * 外部プロキシがURLパス単位でレスポンスをキャッシュする環境があるため、
 * 呼び出しごとに異なる {tag}（タイムスタンプ等）をパスに含めることで
 * 必ずオリジンまで到達させる。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tag: string }> }
) {
  const { tag } = await params

  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const today = jstNow.toISOString().split('T')[0]
  const monthStart = today.slice(0, 7) + '-01'
  const TZ = '+09:00'

  const count = (build: (q: any) => any): Promise<number> => {  // eslint-disable-line @typescript-eslint/no-explicit-any
    const query = build(supabase.from('books').select('id', { count: 'exact', head: true }))
    return (query as unknown as Promise<{ count: number | null }>).then(r => r.count || 0)
  }

  const [pending, rerankPending, todayChecked, monthChecked] = await Promise.all([
    count(q => q
      .or('evaluation_reason.is.null,evaluation_reason.eq.自動検出 - SNS調査待ち,evaluation_reason.like.SNS調査中:*')
      .not('author', 'is', null)
      .not('author', 'eq', '')),
    count(q => q.like('evaluation_reason', '%ルールベース判定%')),
    count(q => q
      .gte('updated_at', `${today}T00:00:00${TZ}`)
      .not('evaluation_reason', 'is', null)
      .not('evaluation_reason', 'eq', '自動検出 - SNS調査待ち')
      .not('evaluation_reason', 'like', 'SNS調査中:%')),
    count(q => q
      .gte('updated_at', `${monthStart}T00:00:00${TZ}`)
      .not('evaluation_reason', 'is', null)
      .not('evaluation_reason', 'eq', '自動検出 - SNS調査待ち')
      .not('evaluation_reason', 'like', 'SNS調査中:%')
      .not('evaluation_reason', 'like', '%スキップ%')),
  ])

  return NextResponse.json({
    tag,
    pending,
    rerankPending,
    todayChecked,
    monthChecked,
    aiComplete: pending === 0 && rerankPending === 0,
    timestamp: new Date().toISOString(),
  })
}
