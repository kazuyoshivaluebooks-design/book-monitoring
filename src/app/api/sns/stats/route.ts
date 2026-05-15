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
  // 1. ランク別の分布（countクエリで正確にカウント）
  const rankCounts: Record<string, number> = {}
  for (const rankVal of ['高確率', '注目', '中確率']) {
    const { count } = await supabase
      .from('books')
      .select('id', { count: 'exact', head: true })
      .eq('rank', rankVal)
      .not('title', 'like', '[詳細取得中]%')
    rankCounts[rankVal] = count || 0
  }
  // ランクなしの数
  const { count: nullRankCount } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .is('rank', null)
    .not('title', 'like', '[詳細取得中]%')
  rankCounts['null'] = nullRankCount || 0

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

  // 6. 今日の新着件数（全体＋ランク別）
  const today = new Date().toISOString().split('T')[0]
  const { count: todayCount } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .gte('discovered_at', `${today}T00:00:00`)
    .lt('discovered_at', `${today}T23:59:59.999`)

  const todayRanks: Record<string, number> = {}
  for (const rankVal of ['高確率', '注目', '中確率']) {
    const { count: rc } = await supabase
      .from('books')
      .select('id', { count: 'exact', head: true })
      .eq('rank', rankVal)
      .gte('discovered_at', `${today}T00:00:00`)
      .lt('discovered_at', `${today}T23:59:59.999`)
    todayRanks[rankVal] = rc || 0
  }

  // 7. 今日SNS調査が完了した件数（updated_atが今日 & evaluation_reasonがnullでない）
  const { count: todayCheckedCount } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .gte('updated_at', `${today}T00:00:00`)
    .not('evaluation_reason', 'is', null)
    .not('evaluation_reason', 'eq', '自動検出 - SNS調査待ち')

  // 7b. 今日の調査完了分のランク別内訳
  const todayCheckedRanks: Record<string, number> = {}
  for (const rankVal of ['高確率', '注目', '中確率']) {
    const { count: rc } = await supabase
      .from('books')
      .select('id', { count: 'exact', head: true })
      .eq('rank', rankVal)
      .gte('updated_at', `${today}T00:00:00`)
      .not('evaluation_reason', 'is', null)
      .not('evaluation_reason', 'eq', '自動検出 - SNS調査待ち')
    todayCheckedRanks[rankVal] = rc || 0
  }

  // 8. 全書籍数
  const { count: totalBooks } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .not('title', 'like', '[詳細取得中]%')

  // 9. 過去7日間の日別新着数
  const dailyStats: Array<{ date: string; newBooks: number; checked: number }> = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().split('T')[0]

    const { count: dayNew } = await supabase
      .from('books')
      .select('id', { count: 'exact', head: true })
      .gte('discovered_at', `${dateStr}T00:00:00`)
      .lt('discovered_at', `${dateStr}T23:59:59.999`)

    const { count: dayChecked } = await supabase
      .from('books')
      .select('id', { count: 'exact', head: true })
      .gte('updated_at', `${dateStr}T00:00:00`)
      .lt('updated_at', `${dateStr}T23:59:59.999`)
      .not('evaluation_reason', 'is', null)
      .not('evaluation_reason', 'eq', '自動検出 - SNS調査待ち')

    dailyStats.push({
      date: dateStr,
      newBooks: dayNew || 0,
      checked: dayChecked || 0,
    })
  }

  // 10. ルールベース判定残数（rerankの対象）
  const { count: rerankPending } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .like('evaluation_reason', '%ルールベース判定%')

  // 11. 検索APIの健全性チェック（クレジット枯渇の早期検知）
  const apiHealth: Record<string, { status: string; detail?: string }> = {}

  // Serperチェック（軽量: 1クレジット消費）
  const serperKey = process.env.SERPER_API_KEY
  if (serperKey) {
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: 'test', num: 1 }),
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        apiHealth.serper = { status: 'ok' }
      } else {
        const text = await res.text().catch(() => '')
        apiHealth.serper = { status: 'error', detail: `HTTP ${res.status}: ${text.slice(0, 100)}` }
      }
    } catch (e) {
      apiHealth.serper = { status: 'error', detail: e instanceof Error ? e.message : String(e) }
    }
  } else {
    apiHealth.serper = { status: 'not_configured' }
  }

  // Braveチェック
  const braveKey = process.env.BRAVE_SEARCH_API_KEY
  if (braveKey) {
    try {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=test&count=1`, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey },
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        apiHealth.brave = { status: 'ok' }
      } else {
        const text = await res.text().catch(() => '')
        apiHealth.brave = { status: 'error', detail: `HTTP ${res.status}: ${text.slice(0, 100)}` }
      }
    } catch (e) {
      apiHealth.brave = { status: 'error', detail: e instanceof Error ? e.message : String(e) }
    }
  } else {
    apiHealth.brave = { status: 'not_configured' }
  }

  return NextResponse.json({
    rankDistribution: rankCounts,
    totalBooks: totalBooks || 0,
    todayNewBooks: todayCount || 0,
    todayChecked: todayCheckedCount || 0,
    todayRankDistribution: todayRanks,
    todayCheckedRanks,
    dailyStats,
    searchQuality: {
      withHits: hitCount || 0,
      zeroResults: zeroCount || 0,
      skipped: skipCount || 0,
      hitRate: hitCount && (hitCount + (zeroCount || 0)) > 0
        ? ((hitCount / (hitCount + (zeroCount || 0))) * 100).toFixed(1) + '%'
        : 'N/A',
    },
    pending: pendingCount || 0,
    rerankPending: rerankPending || 0,
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
    apiHealth,
  })
}
