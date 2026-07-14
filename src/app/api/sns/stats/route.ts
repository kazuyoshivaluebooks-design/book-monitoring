import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 10  // Vercel Hobby plan: max 10s

// GET /api/sns/stats?q=ポインティ  — 著者名で検索
// GET /api/sns/stats                — 全体統計
//
// ※ 旧実装は約30本のDBクエリを直列実行しており10秒制限を超過して
//    タイムアウトしていた。全クエリをPromise.allで並列化して修正。
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

  // JST (UTC+9) で「今日」「今月」を計算
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const today = jstNow.toISOString().split('T')[0]
  const monthStart = today.slice(0, 7) + '-01'
  const TZ = '+09:00' // JST

  const RANKS = ['高確率', '注目', '中確率'] as const

  // countクエリのヘルパー（supabaseのクエリビルダーはthenableなのでawait可能）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const countBooks = (build: (q: any) => any): Promise<number> => {
    const query = build(supabase.from('books').select('id', { count: 'exact', head: true }))
    return (query as unknown as Promise<{ count: number | null }>).then(r => r.count || 0)
  }

  // ─── すべての集計を並列実行 ───
  const [
    // 1. ランク別分布
    rankCountValues,
    nullRankCount,
    // 2. 検索品質
    hitCount,
    zeroCount,
    skipCount,
    // 3. 上位ランクサンプル
    topBooks,
    // 4. 最近処理された書籍
    recentBooks,
    // 5. 未調査の残数（処理中クレーム含む）
    pendingCount,
    // 6. 今日の新着
    todayCount,
    todayRankValues,
    // 7. 今日の調査完了
    todayCheckedCount,
    todayCheckedRankValues,
    // 8. 全書籍数
    totalBooks,
    // 9. 過去7日間
    dailyStatsRaw,
    // 10. ルールベース判定残数
    rerankPending,
    // 12. 今月の調査完了数（コスト計算用）
    monthChecked,
  ] = await Promise.all([
    Promise.all(RANKS.map(rankVal =>
      countBooks(qb => qb.eq('rank', rankVal).not('title', 'like', '[詳細取得中]%'))
    )),
    countBooks(qb => qb.is('rank', null).not('title', 'like', '[詳細取得中]%')),

    countBooks(qb => qb.like('evaluation_reason', '%検索ヒット%')),
    countBooks(qb => qb.like('evaluation_reason', '%結果0件%')),
    countBooks(qb => qb.like('evaluation_reason', '%スキップ%')),

    supabase.from('books')
      .select('title, author, rank, evaluation_reason')
      .in('rank', ['注目', '高確率'])
      .order('release_date', { ascending: false })
      .limit(15)
      .then(r => r.data),

    supabase.from('books')
      .select('title, author, rank, evaluation_reason')
      .not('evaluation_reason', 'is', null)
      .not('evaluation_reason', 'like', '%スキップ%')
      .order('updated_at', { ascending: false })
      .limit(10)
      .then(r => r.data),

    countBooks(qb => qb
      .or('evaluation_reason.is.null,evaluation_reason.eq.自動検出 - SNS調査待ち,evaluation_reason.like.SNS調査中:*')
      .not('author', 'is', null)
      .not('author', 'eq', '')),

    countBooks(qb => qb
      .gte('discovered_at', `${today}T00:00:00${TZ}`)
      .lt('discovered_at', `${today}T23:59:59.999${TZ}`)),
    Promise.all(RANKS.map(rankVal =>
      countBooks(qb => qb
        .eq('rank', rankVal)
        .gte('discovered_at', `${today}T00:00:00${TZ}`)
        .lt('discovered_at', `${today}T23:59:59.999${TZ}`))
    )),

    countBooks(qb => qb
      .gte('updated_at', `${today}T00:00:00${TZ}`)
      .not('evaluation_reason', 'is', null)
      .not('evaluation_reason', 'eq', '自動検出 - SNS調査待ち')
      .not('evaluation_reason', 'like', 'SNS調査中:%')),
    Promise.all(RANKS.map(rankVal =>
      countBooks(qb => qb
        .eq('rank', rankVal)
        .gte('updated_at', `${today}T00:00:00${TZ}`)
        .not('evaluation_reason', 'is', null)
        .not('evaluation_reason', 'eq', '自動検出 - SNS調査待ち'))
    )),

    countBooks(qb => qb.not('title', 'like', '[詳細取得中]%')),

    Promise.all(Array.from({ length: 7 }, (_, idx) => {
      const i = 6 - idx
      const d = new Date(Date.now() + 9 * 60 * 60 * 1000)
      d.setDate(d.getDate() - i)
      const dateStr = d.toISOString().split('T')[0]
      return Promise.all([
        countBooks(qb => qb
          .gte('discovered_at', `${dateStr}T00:00:00${TZ}`)
          .lt('discovered_at', `${dateStr}T23:59:59.999${TZ}`)),
        countBooks(qb => qb
          .gte('updated_at', `${dateStr}T00:00:00${TZ}`)
          .lt('updated_at', `${dateStr}T23:59:59.999${TZ}`)
          .not('evaluation_reason', 'is', null)
          .not('evaluation_reason', 'eq', '自動検出 - SNS調査待ち')),
      ]).then(([newBooks, checked]) => ({ date: dateStr, newBooks, checked }))
    })),

    countBooks(qb => qb.like('evaluation_reason', '%ルールベース判定%')),

    countBooks(qb => qb
      .gte('updated_at', `${monthStart}T00:00:00${TZ}`)
      .not('evaluation_reason', 'is', null)
      .not('evaluation_reason', 'eq', '自動検出 - SNS調査待ち')
      .not('evaluation_reason', 'like', 'SNS調査中:%')
      .not('evaluation_reason', 'like', '%スキップ%')),
  ])

  const rankCounts: Record<string, number> = {}
  RANKS.forEach((rankVal, i) => { rankCounts[rankVal] = rankCountValues[i] })
  rankCounts['null'] = nullRankCount

  const todayRanks: Record<string, number> = {}
  RANKS.forEach((rankVal, i) => { todayRanks[rankVal] = todayRankValues[i] })

  const todayCheckedRanks: Record<string, number> = {}
  RANKS.forEach((rankVal, i) => { todayCheckedRanks[rankVal] = todayCheckedRankValues[i] })

  // 11. 検索APIの健全性チェック（並列実行、クレジット枯渇の早期検知）
  const apiHealth: Record<string, { status: string; detail?: string }> = {}
  let serperCreditsRemaining: number | null = null

  const serperKey = process.env.SERPER_API_KEY
  const braveKey = process.env.BRAVE_SEARCH_API_KEY

  await Promise.all([
    (async () => {
      if (!serperKey) { apiHealth.serper = { status: 'not_configured' }; return }
      try {
        const res = await fetch('https://google.serper.dev/account', {
          method: 'GET',
          headers: { 'X-API-KEY': serperKey },
          signal: AbortSignal.timeout(3000),
        })
        if (res.ok) {
          const account = await res.json()
          const credits = account.credits ?? null
          serperCreditsRemaining = typeof credits === 'number' ? credits : null
          apiHealth.serper = {
            status: credits !== null && credits <= 0 ? 'error' : 'ok',
            detail: credits !== null ? `残クレジット: ${credits.toLocaleString()}` : undefined,
          }
        } else {
          const text = await res.text().catch(() => '')
          apiHealth.serper = { status: 'error', detail: `HTTP ${res.status}: ${text.slice(0, 100)}` }
        }
      } catch (e) {
        apiHealth.serper = { status: 'error', detail: e instanceof Error ? e.message : String(e) }
      }
    })(),
    (async () => {
      if (!braveKey) { apiHealth.brave = { status: 'not_configured' }; return }
      try {
        const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=test&count=1`, {
          headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey },
          signal: AbortSignal.timeout(3000),
        })
        if (res.ok) {
          apiHealth.brave = { status: 'ok' }
        } else if (res.status === 402 || res.status === 429) {
          // 月額上限到達 or レート制限は想定内 — warningとして表示
          apiHealth.brave = { status: 'warning', detail: `月額クォータ上限またはレート制限（HTTP ${res.status}）` }
        } else {
          const text = await res.text().catch(() => '')
          apiHealth.brave = { status: 'error', detail: `HTTP ${res.status}: ${text.slice(0, 100)}` }
        }
      } catch (e) {
        apiHealth.brave = { status: 'error', detail: e instanceof Error ? e.message : String(e) }
      }
    })(),
  ])

  // 13. コスト概算（今月）
  // Serper: 1冊 = 3クレジット = $0.003（$50/50,000クレジット換算）
  // Claude: 1冊 ≈ $0.002（claude-sonnet-4-6、入出力トークン概算）
  const serperCreditsUsedEst = monthChecked * 3
  const estCostUsd = Math.round((serperCreditsUsedEst / 1000 * 1.0 + monthChecked * 0.002) * 100) / 100
  const costs = {
    month: monthStart.slice(0, 7),
    monthChecked,
    serperCreditsUsedEst,
    serperCreditsRemaining,
    estCostUsd,
    note: 'Serper $1/1,000クレジット + Claude約$0.002/冊 で概算。Brave/YouTubeは無料枠内',
  }

  return NextResponse.json({
    rankDistribution: rankCounts,
    totalBooks,
    todayNewBooks: todayCount,
    todayChecked: todayCheckedCount,
    todayRankDistribution: todayRanks,
    todayCheckedRanks,
    dailyStats: dailyStatsRaw,
    searchQuality: {
      withHits: hitCount,
      zeroResults: zeroCount,
      skipped: skipCount,
      hitRate: hitCount && (hitCount + zeroCount) > 0
        ? ((hitCount / (hitCount + zeroCount)) * 100).toFixed(1) + '%'
        : 'N/A',
    },
    pending: pendingCount,
    rerankPending,
    costs,
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
