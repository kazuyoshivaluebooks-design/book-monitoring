import { NextRequest, NextResponse, after } from 'next/server'
import { supabase } from '@/lib/supabase'
import type { SnsData } from '@/lib/supabase'
import { rankBook } from '@/lib/sns/ranker'
import type { YouTubeChannelData } from '@/lib/sns/youtube'
import type { SocialProfile, SearchResultRaw } from '@/lib/sns/social-search'

export const dynamic = 'force-dynamic'
export const maxDuration = 10  // Vercel Hobby plan: max 10s

/**
 * GET /api/sns/rerank
 *
 * ルールベース判定された書籍をClaude AIで再ランク判定する。
 * 既存のSNSデータを使い、Claude APIのみ呼び直す。
 *
 * Query params:
 *   - limit: 一度に処理する件数 (default: 2, max: 5)
 *   - token: CRON_SECRET認証トークン
 *
 * cron-job.org から5分おきに呼び出す想定:
 *   URL: https://your-app.vercel.app/api/sns/rerank?token=YOUR_CRON_SECRET
 */
export async function GET(request: NextRequest) {
  // ※ /api/sns/check と同様、ダッシュボード・自動バッチから直接呼べるよう認証なし。
  //   tokenが渡された場合のみ検証する（後方互換）。
  const cronSecret = process.env.CRON_SECRET
  const token = request.nextUrl.searchParams.get('token')
  if (cronSecret && token && token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicApiKey) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY が設定されていません' },
      { status: 500 }
    )
  }

  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get('limit') || '2', 10),
    5
  )
  // 自走ループ: chain > 0 なら処理後に自分自身を chain-1 で呼び直す
  const chain = Math.min(Math.max(parseInt(request.nextUrl.searchParams.get('chain') || '0', 10), 0), 2000)
  const prevRemaining = parseInt(request.nextUrl.searchParams.get('prev') || '-1', 10)
  const stall = Math.min(Math.max(parseInt(request.nextUrl.searchParams.get('stall') || '5', 10), 0), 5)
  const origin = request.nextUrl.origin

  // 自走ループモード: 即ACKを返し、実処理は応答後に実行（checkと同方式）。
  // 前リンクからの短時間dispatchがACKを受けて正常完了するためチェーンが安定する。
  if (chain > 0) {
    after(async () => {
      try {
        const result = await runRerankBatch({ limit, chain, prevRemaining, stall, origin, anthropicApiKey })
        console.log(`[chain] rerank chain=${chain} processed=${result.processed} remaining=${result.remaining}`)
      } catch (e) {
        console.error(`[chain] rerank chain=${chain} error:`, e)
      }
    })
    return NextResponse.json({ accepted: true, mode: 'chain', chain, timestamp: new Date().toISOString() })
  }

  try {
    const result = await runRerankBatch({ limit, chain: 0, prevRemaining, stall, origin, anthropicApiKey })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : String(e),
        source: 'sns/rerank',
      },
      { status: 500 }
    )
  }
}

/**
 * 1バッチ分の再判定処理本体。
 */
async function runRerankBatch(opts: {
  limit: number
  chain: number
  prevRemaining: number
  stall: number
  origin: string
  anthropicApiKey: string
}): Promise<Record<string, unknown>> {
  const { limit, chain, prevRemaining, stall, origin, anthropicApiKey } = opts
  const startTime = Date.now()

  {
    // ルールベース判定された書籍を取得
    const { data: books, error: fetchError } = await supabase
      .from('books')
      .select('id, title, author, publisher, isbn, price, release_date, sns_data, evaluation_reason, description')
      .like('evaluation_reason', '%ルールベース判定%')
      .order('release_date', { ascending: true, nullsFirst: false })
      .limit(limit)

    if (fetchError) {
      throw new Error(`DB取得エラー: ${fetchError.message}`)
    }

    if (!books || books.length === 0) {
      // 残数を確認
      const remaining = await getRemainingCount()
      return {
        message: 'ルールベース判定の書籍はすべて再判定完了',
        processed: 0,
        remaining,
        source: 'sns/rerank',
        timestamp: new Date().toISOString(),
      }
    }

    const results: Array<{
      bookId: string
      title: string
      author: string
      oldRank: string | null
      newRank: string | null
      oldReason: string
      newReason: string
      error?: string
    }> = []

    for (const book of books) {
      // タイムアウト防止: 7秒で打ち切り
      if (Date.now() - startTime > 7000) break

      try {
        const snsData: SnsData = book.sns_data || {}

        // 既存SNSデータからrankBookの入力を再構成
        const youtube = reconstructYouTube(snsData)
        const socialProfiles = reconstructProfiles(snsData)
        const rawSearchResults: SearchResultRaw[] = []  // 生データは保存されていないため空

        const rankResult = await rankBook(
          {
            title: book.title,
            author: book.author,
            publisher: book.publisher,
            isbn: book.isbn,
            price: book.price,
            releaseDate: book.release_date,
            description: book.description,
          },
          youtube,
          socialProfiles,
          rawSearchResults,
          anthropicApiKey,
          // 再判定は検索ステップがない分、Claude判定に時間を割ける
          Math.max(Math.min(8500 - (Date.now() - startTime), 7000), 1500)
        )

        // 再判定であることを明記
        const newReason = `${rankResult.evaluationReason} [再判定: ルールベース→Claude AI]`

        // DB更新（sns_dataは変更しない、rankとevaluation_reasonのみ更新）
        const { error: updateError } = await supabase
          .from('books')
          .update({
            rank: rankResult.rank,
            evaluation_reason: newReason,
          })
          .eq('id', book.id)

        if (updateError) {
          results.push({
            bookId: book.id,
            title: book.title,
            author: book.author,
            oldRank: book.sns_data?.youtube?.subscribers ? 'had-data' : null,
            newRank: rankResult.rank,
            oldReason: book.evaluation_reason || '',
            newReason,
            error: `DB更新エラー: ${updateError.message}`,
          })
        } else {
          results.push({
            bookId: book.id,
            title: book.title,
            author: book.author,
            oldRank: extractOldRank(book.evaluation_reason),
            newRank: rankResult.rank,
            oldReason: book.evaluation_reason || '',
            newReason,
          })
        }
      } catch (e) {
        results.push({
          bookId: book.id,
          title: book.title,
          author: book.author,
          oldRank: null,
          newRank: null,
          oldReason: book.evaluation_reason || '',
          newReason: '',
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    const remaining = await getRemainingCount()

    // ─── 自走ループ: 次のリンクを送信 ───
    let chained: string | null = null
    if (chain > 0 && remaining > 0) {
      const newStall = prevRemaining >= 0 && remaining >= prevRemaining ? stall - 1 : 5
      if (newStall > 0) {
        chained = `rerank(chain=${chain - 1})`
        try {
          await fetch(
            `${origin}/api/sns/rerank?limit=${limit}&chain=${chain - 1}&prev=${remaining}&stall=${newStall}&t=${Date.now()}`,
            { signal: AbortSignal.timeout(1200) }
          )
        } catch { /* abort想定内 — 受け側は即ACKを返すため処理は継続される */ }
      }
    }

    return {
      processed: results.length,
      remaining,
      results,
      ...(chained ? { chained } : {}),
      source: 'sns/rerank',
      elapsedMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    }
  }
}

/**
 * ルールベース判定の残数を取得
 */
async function getRemainingCount(): Promise<number> {
  const { count } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .like('evaluation_reason', '%ルールベース判定%')
  return count || 0
}

/**
 * evaluation_reasonから元のランクを抽出（ログ用）
 */
function extractOldRank(reason: string | null): string | null {
  if (!reason) return null
  // "SNS合計フォロワーXX人（ルールベース判定）" のようなパターンからは
  // 直接ランクは読めないが、書籍のrankカラムに入っている値を使う
  return null
}

/**
 * 保存済みsns_dataからYouTubeChannelDataを再構成
 * ※ 詳細データ（再生回数、動画リスト等）は保存されていないため簡略版
 */
function reconstructYouTube(snsData: SnsData): YouTubeChannelData | null {
  if (!snsData.youtube) return null

  return {
    channelId: '',
    channelTitle: '',
    channelUrl: snsData.youtube.url || '',
    subscriberCount: snsData.youtube.subscribers || 0,
    videoCount: 0,
    viewCount: 0,
    recentVideos: [],
  }
}

/**
 * 保存済みsns_dataからSocialProfile[]を再構成
 */
function reconstructProfiles(snsData: SnsData): SocialProfile[] {
  const profiles: SocialProfile[] = []

  const platformKeys: Array<{
    key: 'x' | 'instagram' | 'facebook' | 'tiktok' | 'voicy' | 'standfm' | 'podcast' | 'note'
    platform: SocialProfile['platform']
  }> = [
    { key: 'x', platform: 'x' },
    { key: 'instagram', platform: 'instagram' },
    { key: 'facebook', platform: 'facebook' },
    { key: 'tiktok', platform: 'tiktok' },
    { key: 'voicy', platform: 'voicy' },
    { key: 'standfm', platform: 'standfm' },
    { key: 'podcast', platform: 'podcast' },
    { key: 'note', platform: 'note' },
  ]

  for (const { key, platform } of platformKeys) {
    const data = snsData[key]
    if (data) {
      profiles.push({
        platform,
        url: data.url || '',
        displayName: null,
        snippet: null,
        estimatedFollowers: data.followers,
      })
    }
  }

  return profiles
}
