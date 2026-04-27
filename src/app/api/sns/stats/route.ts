import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// GET /api/sns/stats?q=ポインティ  — 著者名で検索
// GET /api/sns/stats                — 全体統計
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')

  // クエリパラメータがあれば著者名+タイトル検索モード
  if (q) {
    const { data: books } = await supabase
      .from('books')
      .select('title, author, rank, evaluation_reason, sns_data, release_date')
      .or(`author.ilike.%${q}%,title.ilike.%${q}%`)
      .limit(20)

    return NextResponse.json({
      query: q,
      count: books?.length || 0,
      books: (books || []).map(b => ({
        title: b.title,
        author: b.author,
        rank: b.rank,
        releaseDate: b.release_date,
        reason: (b.evaluation_reason || '').slice(0, 200),
        snsData: b.sns_data,
      })),
    })
  }
  // 1. ランク別の分布
  const { data: rankDist } = await supabase
    .from('books')
    .select('rank')
    .not('evaluation_reason', 'is', null)

  const rankCounts: Record<string, number> = {}
  for (const row of rankDist || []) {
    const r = row.rank || 'null'
    rankCounts[r] = (rankCounts[r] || 0) + 1
  }

  // 2. 検索ヒットありvs結果0件
  const { count: hitCount } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .like('evaluation_reason', '%検索ヒット%')

  const { count: zeroCount } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .like('evaluation_reason', '%結果0件%')

  const { count: skipCount } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .like('evaluation_reason', '%スキップ%')

  // 3. 「注目」「高確率」ランクの書籍サンプル（精度確認用）
  const { data: topBooks } = await supabase
    .from('books')
    .select('title, author, rank, evaluation_reason')
    .in('rank', ['注目', '高確率'])
    .order('release_date', { ascending: false })
    .limit(15)

  // 4. 最近処理された書籍サンプル
  const { data: recentBooks } = await supabase
    .from('books')
    .select('title, author, rank, evaluation_reason')
    .not('evaluation_reason', 'is', null)
    .not('evaluation_reason', 'like', '%スキップ%')
    .order('updated_at', { ascending: false })
    .limit(10)

  // 5. 未調査の残数
  const { count: pendingCount } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .or('evaluation_reason.is.null,evaluation_reason.eq.自動検出 - SNS調査待ち')
    .not('author', 'is', null)
    .not('author', 'eq', '')

  return NextResponse.json({
    rankDistribution: rankCounts,
    searchQuality: {
      withHits: hitCount || 0,
      zeroResults: zeroCount || 0,
      skipped: skipCount || 0,
      hitRate: hitCount && (hitCount + (zeroCount || 0)) > 0
        ? ((hitCount / (hitCount + (zeroCount || 0))) * 100).toFixed(1) + '%'
        : 'N/A',
    },
    pending: pendingCount || 0,
    topRankedBooks: (topBooks || []).map(b => ({
      title: b.title,
      author: b.author,
      rank: b.rank,
      reason: (b.evaluation_reason || '').slice(0, 120),
    })),
    recentlyProcessed: (recentBooks || []).map(b => ({
      title: b.title,
      author: b.author,
      rank: b.rank,
      reason: (b.evaluation_reason || '').slice(0, 120),
    })),
  })
}
