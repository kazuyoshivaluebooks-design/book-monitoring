import { NextRequest, NextResponse, after } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getYouTubeChannelByUrl } from '@/lib/sns/youtube'
import { searchSocialProfiles, extractYouTubeUrls, QuotaExhaustedError } from '@/lib/sns/social-search'
import { rankBook } from '@/lib/sns/ranker'

export const dynamic = 'force-dynamic'
export const maxDuration = 10  // Vercel Hobby plan: max 10s

/**
 * POST /api/sns/check
 * 指定された書籍のSNS調査を実行してランク判定する
 *
 * Body: { bookId: string } または { bookIds: string[] }
 *
 * GET /api/sns/check?pending=true&limit=5
 * SNS未調査の書籍を自動取得して一括処理
 */

/**
 * 著者名がSNS調査に不適切かどうかを判定（機関名・委員会等をスキップ）
 * SNS検索APIの呼び出しを節約するためのプレフィルタ
 */
const SKIP_AUTHOR_PATTERNS = [
  /委員会$/, /研究会$/, /研究所$/, /協会$/, /学会$/,
  /事務局$/, /編集部$/, /制作委員会$/, /プロジェクト$/,
  /省$/, /庁$/, /局$/, /課$/, /部会$/,
  /株式会社/, /有限会社/, /合同会社/, /一般社団法人/, /一般財団法人/,
  /^編集/, /制作$/, /事務所$/,
]

function shouldSkipAuthor(authorName: string): boolean {
  return SKIP_AUTHOR_PATTERNS.some(p => p.test(authorName))
}

async function checkSingleBook(bookId: string, deadlineAt: number = Date.now() + 8500): Promise<{
  bookId: string
  title: string
  author: string
  rank: string | null
  evaluationReason: string
  error?: string
}> {
  // 書籍情報を取得
  const { data: book, error: fetchError } = await supabase
    .from('books')
    .select('*')
    .eq('id', bookId)
    .single()

  if (fetchError || !book) {
    return {
      bookId,
      title: '不明',
      author: '不明',
      rank: null,
      evaluationReason: '',
      error: `書籍取得エラー: ${fetchError?.message || '見つかりません'}`,
    }
  }

  // 著者名の前処理（"山田太郎／著" → "山田太郎"）
  const rawAuthor = book.author || ''
  const authorName = rawAuthor
    .split(/[／\/,、]/)[0]  // 最初の著者のみ
    .replace(/[（(].*?[）)]/, '')  // 括弧内を除去
    .replace(/(著|編|監修|訳|翻訳|イラスト|写真)$/, '')  // 役割を除去
    .trim()

  if (!authorName) {
    // 著者名なしの場合はスキップ
    await supabase.from('books').update({
      evaluation_reason: 'SNS調査スキップ: 著者名が空',
    }).eq('id', bookId)

    return {
      bookId,
      title: book.title,
      author: rawAuthor,
      rank: null,
      evaluationReason: 'SNS調査スキップ: 著者名が空',
    }
  }

  // 機関名・委員会等はSNS調査をスキップ（API節約）
  if (shouldSkipAuthor(authorName)) {
    await supabase.from('books').update({
      evaluation_reason: `SNS調査スキップ: 機関名（${authorName}）`,
    }).eq('id', bookId)

    return {
      bookId,
      title: book.title,
      author: rawAuthor,
      rank: null,
      evaluationReason: `SNS調査スキップ: 機関名（${authorName}）`,
    }
  }

  // 1. Web検索（SNSプロフィール検出 + 生データをClaudeに渡す）
  const googleSearchApiKey = process.env.GOOGLE_SEARCH_API_KEY
  const googleSearchCx = process.env.GOOGLE_SEARCH_CX
  const { profiles: socialProfiles, rawResults } = await searchSocialProfiles(
    authorName,
    googleSearchApiKey,
    googleSearchCx
  )

  // 2. YouTube: Web検索結果からチャンネルURLを抽出し、API(1ユニット)で正確なデータ取得
  //    ※ B案: searchYouTubeAuthor(100ユニット)を廃止し、Web検索結果を主経路に
  const youtubeApiKey = process.env.YOUTUBE_API_KEY
  let youtube = null
  // 残り時間が5秒未満ならYouTube照会を省略（Claude判定の時間を確保）
  const timeLeftForYoutube = deadlineAt - Date.now()
  if (youtubeApiKey && rawResults.length > 0 && timeLeftForYoutube > 5000) {
    // YouTube照会は残り時間に応じて最大3秒に制限
    const ytBudget = Math.min(3000, timeLeftForYoutube - 4500)
    youtube = await Promise.race([
      (async () => {
        const ytUrls = extractYouTubeUrls(rawResults)
        for (const ytUrl of ytUrls.slice(0, 2)) {
          const channelData = await getYouTubeChannelByUrl(ytUrl, youtubeApiKey)
          if (channelData && channelData.subscriberCount > 0) {
            return channelData
          }
        }
        return null
      })(),
      new Promise<null>(resolve => setTimeout(() => resolve(null), ytBudget)),
    ])
  }

  // 3. Claude API でランク判定
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicApiKey) {
    return {
      bookId,
      title: book.title,
      author: rawAuthor,
      rank: null,
      evaluationReason: 'ANTHROPIC_API_KEY が設定されていません',
      error: 'ANTHROPIC_API_KEY 未設定',
    }
  }

  // 残り時間からClaude判定に使える時間を算出（DB更新用に700ms残す）
  // 時間が足りない場合はrankBook内部でルールベース判定に自動フォールバック
  const claudeTimeout = Math.max(deadlineAt - Date.now() - 700, 0)

  const rankResult = await rankBook(
    {
      title: book.title,
      author: rawAuthor,
      publisher: book.publisher,
      isbn: book.isbn,
      price: book.price,
      releaseDate: book.release_date,
      description: book.description,
    },
    youtube,
    socialProfiles,
    rawResults,
    anthropicApiKey,
    claudeTimeout
  )

  // デバッグ: 検索結果の詳細をevaluation_reasonに追加
  if (rawResults.length > 0) {
    const debugInfo = rawResults.slice(0, 3).map(r => `[${r.title}](${r.url})`).join('; ')
    rankResult.evaluationReason += ` [検索ヒット${rawResults.length}件: ${debugInfo.slice(0, 200)}]`
  } else {
    rankResult.evaluationReason += ' [検索: 結果0件]'
  }

  // 4. Supabase を更新
  // sns_data が空の場合でも「調査済み」マーカーを付与して再処理を防止
  const finalSnsData = Object.keys(rankResult.snsData).length === 0
    ? { _checked: true, _checkedAt: new Date().toISOString() }
    : { ...rankResult.snsData, _checkedAt: new Date().toISOString() }

  const { error: updateError } = await supabase
    .from('books')
    .update({
      rank: rankResult.rank,
      sns_data: finalSnsData,
      evaluation_reason: rankResult.evaluationReason,
    })
    .eq('id', bookId)

  if (updateError) {
    return {
      bookId,
      title: book.title,
      author: rawAuthor,
      rank: rankResult.rank,
      evaluationReason: rankResult.evaluationReason,
      error: `DB更新エラー: ${updateError.message}`,
    }
  }

  return {
    bookId,
    title: book.title,
    author: rawAuthor,
    rank: rankResult.rank,
    evaluationReason: rankResult.evaluationReason,
  }
}

// POST: 特定の書籍を調査
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const bookIds: string[] = body.bookIds || (body.bookId ? [body.bookId] : [])

    if (bookIds.length === 0) {
      return NextResponse.json({ error: 'bookId または bookIds が必要です' }, { status: 400 })
    }

    const results = []
    for (const id of bookIds) {
      const result = await checkSingleBook(id)
      results.push(result)
    }

    return NextResponse.json({ results })
  } catch (e) {
    if (e instanceof QuotaExhaustedError) {
      return NextResponse.json(
        { error: e.message, quotaExhausted: true, processed: 0, remaining: -1 },
        { status: 429 }
      )
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}

// ─── 排他ロック（クレーム）方式 ───
// 複数の呼び出しが並走しても同じ本を二重処理しないよう、
// 処理開始時に evaluation_reason へ「SNS調査中:<epoch ms>」マーカーを
// 条件付きUPDATEで書き込む（勝った呼び出しだけがその本を処理できる）。
// 関数がタイムアウトで死んでもマーカーが残るだけなので、
// CLAIM_STALE_MS を過ぎた古いマーカーは未調査扱いに戻して再処理する。

const PENDING_OR = 'evaluation_reason.is.null,evaluation_reason.eq.自動検出 - SNS調査待ち'
const CLAIM_PREFIX = 'SNS調査中:'
const CLAIM_STALE_MS = 3 * 60 * 1000  // 3分

/**
 * 未調査書籍の残数を取得（処理中クレームも「未完了」として数える）
 */
async function getPendingCount(): Promise<number> {
  const { count } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .or(`${PENDING_OR},evaluation_reason.like.${CLAIM_PREFIX}*`)
    .not('author', 'is', null)
    .not('author', 'eq', '')
  return count || 0
}

/** クレームを解除して未調査状態に戻す（エラー時の再キュー用） */
async function releaseClaim(bookId: string): Promise<void> {
  await supabase
    .from('books')
    .update({ evaluation_reason: '自動検出 - SNS調査待ち' })
    .eq('id', bookId)
    .like('evaluation_reason', `${CLAIM_PREFIX}%`)
}

/**
 * 未調査書籍を最大limit冊アトミックにクレームする。
 * 戻り値はクレームに成功した書籍IDのリスト。
 */
async function claimPendingBooks(limit: number): Promise<string[]> {
  // 候補1: 通常の未調査書籍（発売日昇順）
  const { data: candidates } = await supabase
    .from('books')
    .select('id')
    .or(PENDING_OR)
    .not('author', 'is', null)
    .not('author', 'eq', '')
    .order('release_date', { ascending: true, nullsFirst: false })
    .limit(limit * 2)  // クレーム競合に負ける分を見込んで多めに取る

  // 候補2: 期限切れクレーム（前の呼び出しがタイムアウトで死んだ本）
  const { data: staleRows } = await supabase
    .from('books')
    .select('id, evaluation_reason')
    .like('evaluation_reason', `${CLAIM_PREFIX}%`)
    .limit(20)

  const now = Date.now()
  const staleClaims = (staleRows || []).filter(r => {
    const ts = parseInt((r.evaluation_reason || '').slice(CLAIM_PREFIX.length), 10)
    return !Number.isFinite(ts) || now - ts > CLAIM_STALE_MS
  })

  const claimValue = `${CLAIM_PREFIX}${now}`

  // クレーム試行を並列実行（直列だとDB往復×冊数で数秒かかり10秒制限を圧迫する）
  const normalTargets = (candidates || []).slice(0, limit).map(c => ({ id: c.id, staleValue: null as string | null }))
  const staleTargets = staleClaims.slice(0, limit).map(s => ({ id: s.id, staleValue: s.evaluation_reason as string }))
  const targets = [...normalTargets, ...staleTargets].slice(0, limit + 2)

  const attempts = await Promise.all(targets.map(async t => {
    let query = supabase
      .from('books')
      .update({ evaluation_reason: claimValue })
      .eq('id', t.id)
    // 通常候補は「まだ未調査のままなら」、期限切れは「古いマーカー値のままなら」勝ち
    query = t.staleValue === null ? query.or(PENDING_OR) : query.eq('evaluation_reason', t.staleValue)
    const { data: won } = await query.select('id')
    return won && won.length > 0 ? t.id : null
  }))

  return attempts.filter((id): id is string => id !== null).slice(0, limit)
}

/**
 * 自走ループ: 次のリンクを送信して即座に戻る。
 * 応答は待たない（送信後にabortしてもVercel側の処理は完走する）。
 */
async function dispatchNext(origin: string, path: string): Promise<void> {
  try {
    await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(1200) })
  } catch { /* abort想定内 — 送信済みなら処理は継続される */ }
}

type CheckBatchResult = Record<string, unknown>

/**
 * 1バッチ分の処理本体。
 * 通常モードではGETがawaitして結果を返し、自走ループ（chain）モードでは
 * 即座にACK応答を返した後、after()内でこの関数が実行される。
 * （次リンクへのdispatchを短時間でabortしても、受け側は即ACKを返すため
 *   接続切断による処理中断が起きない）
 */
async function runCheckBatch(opts: {
  limit: number
  chain: number
  prevRemaining: number
  stall: number
  origin: string
}): Promise<CheckBatchResult> {
  const { limit, chain, prevRemaining, stall, origin } = opts
  const startTime = Date.now()

  // 排他ロック付きで未調査書籍を確保（並列呼び出しでも二重処理しない）
  const claimedIds = await claimPendingBooks(limit)

  if (claimedIds.length === 0) {
    const remaining = await getPendingCount()
    // 自走ループ中で「全てクレーム中」なら少し先で再試行（別レーンが処理中）
    if (chain > 0 && remaining > 0) {
      const newStall = prevRemaining >= 0 && remaining >= prevRemaining ? stall - 1 : 5
      if (newStall > 0) {
        await dispatchNext(origin, `/api/sns/check?limit=${limit}&chain=${chain - 1}&prev=${remaining}&stall=${newStall}&t=${Date.now()}`)
      }
    } else if (chain > 0 && remaining === 0) {
      await dispatchNext(origin, `/api/sns/rerank?limit=3&chain=${chain - 1}&t=${Date.now()}`)
    }
    return {
      message: remaining === 0
        ? 'SNS未調査の書籍はありません（全件処理完了）'
        : '未調査の書籍は他の呼び出しが処理中です',
      processed: 0,
      remaining,
    }
  }

  // クレームした本を並列処理（1冊ずつの直列処理から変更 — 同じ10秒で複数冊処理）
  // 締め切り制御: Vercelの10秒制限で関数ごと殺されると全結果が失われるため、
  // 締め切り時点で未完了の本は段階的省略で完了させ、完了分だけ確実に返す。
  // 自走ループ時は次リンク送信の時間(約1.3秒)を確保するため締め切りを前倒し。
  // 自走ループ時: ACK応答(0.2s) + クレーム + 処理 + 集計(0.3s) + 次リンク送信(1.2s)
  // の合計が10秒に収まるよう、処理の締め切りを6秒に抑える（時間不足の本は
  // 段階的省略で完了し、ルールベースになった分は後段のrerankが拾う）
  const DEADLINE_MS = chain > 0 ? 6000 : 8300
  const budgetLeft = Math.max(DEADLINE_MS - (Date.now() - startTime), 1000)
    type BookResult = Awaited<ReturnType<typeof checkSingleBook>>
    type RaceOutcome = { kind: 'ok'; value: BookResult } | { kind: 'error'; reason: unknown } | { kind: 'deadline' }

    const deadline = new Promise<RaceOutcome>(resolve =>
      setTimeout(() => resolve({ kind: 'deadline' }), budgetLeft)
    )

    // 各本に「関数の締め切り」を渡す。本ごとに残り時間へ収まるよう段階的に
    // 省略しながら必ず完了する設計なので、外側のdeadline raceは保険として残す。
    const perBookDeadline = startTime + DEADLINE_MS - 300
    const settled = await Promise.all(claimedIds.map(id =>
      Promise.race([
        checkSingleBook(id, perBookDeadline)
          .then((value): RaceOutcome => ({ kind: 'ok', value }))
          .catch((reason): RaceOutcome => ({ kind: 'error', reason })),
        deadline,
      ])
    ))

    const results: Array<{ bookId?: string; title?: string; author?: string; rank?: string | null; evaluationReason?: string; error?: string }> = []
    let quotaExhausted = false
    let quotaError = ''
    const toRelease: string[] = []

    for (let i = 0; i < settled.length; i++) {
      const s = settled[i]
      if (s.kind === 'ok') {
        results.push(s.value)
      } else if (s.kind === 'deadline') {
        // 時間切れ（保険が発動した稀なケース）— クレームは解除せず残す。
        // 3分後にstale扱いで自動再処理される。即時解除すると次の呼び出しが
        // 同じ重い本を先頭から掴み直して無限ループになるため。
      } else {
        // 失敗した本はクレームを解除して再キュー（調査済み扱いにしない）
        toRelease.push(claimedIds[i])
        if (s.reason instanceof QuotaExhaustedError) {
          quotaExhausted = true
          quotaError = s.reason.message
        } else {
          results.push({ bookId: claimedIds[i], error: String(s.reason) })
        }
      }
    }

    if (toRelease.length > 0) {
      await Promise.all(toRelease.map(id => releaseClaim(id)))
    }

    const processed = results.filter(r => !r.error).length
    const remaining = await getPendingCount()

    // ─── 自走ループ: 次のリンクを送信 ───
    let chained: string | null = null
    if (chain > 0 && !quotaExhausted) {
      const newStall = prevRemaining >= 0 && remaining >= prevRemaining ? stall - 1 : 5
      if (remaining > 0 && newStall > 0) {
        // 未調査が残っている → 自分自身を呼び直す
        chained = `check(chain=${chain - 1})`
        await dispatchNext(origin, `/api/sns/check?limit=${limit}&chain=${chain - 1}&prev=${remaining}&stall=${newStall}&t=${Date.now()}`)
      } else if (remaining === 0) {
        // 未調査ゼロ → 簡易判定のAI再判定フェーズへ
        chained = `rerank(chain=${chain - 1})`
        await dispatchNext(origin, `/api/sns/rerank?limit=3&chain=${chain - 1}&t=${Date.now()}`)
      }
      // newStall <= 0（停滞）の場合は連鎖を止める
    }

  return {
    processed,
    remaining,
    results,
    ...(quotaExhausted ? { quotaExhausted: true, quotaError } : {}),
    ...(chained ? { chained } : {}),
    elapsedMs: Date.now() - startTime,
  }
}

// GET: 未調査の書籍を処理（cron / 外部cron / ダッシュボード自動呼び出し / 自走ループ）
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '3', 10), 1), 6)
  // 自走ループ: chain > 0 なら処理後に自分自身を chain-1 で呼び直す
  const chain = Math.min(Math.max(parseInt(searchParams.get('chain') || '0', 10), 0), 2000)
  // 停滞ガード: 残数が減らないまま stall 回連鎖したら停止（無限ループ防止）
  const prevRemaining = parseInt(searchParams.get('prev') || '-1', 10)
  const stall = Math.min(Math.max(parseInt(searchParams.get('stall') || '5', 10), 0), 5)
  const origin = request.nextUrl.origin

  // ※ このエンドポイントはダッシュボードから直接呼ばれるため認証なし
  // 外部cronサービスからは /api/cron/sns-batch 経由で呼び出す（認証付き）

  // 自走ループモード: 即座にACKを返し、実処理は応答後に実行する。
  // 前のリンクからのdispatch（1.2秒でabort）がこのACKを受け取って正常完了
  // するため、接続切断による関数中断が起きず、チェーンが安定して続く。
  if (chain > 0) {
    after(async () => {
      try {
        const result = await runCheckBatch({ limit, chain, prevRemaining, stall, origin })
        console.log(`[chain] check chain=${chain} processed=${result.processed} remaining=${result.remaining}`)
      } catch (e) {
        console.error(`[chain] check chain=${chain} error:`, e)
      }
    })
    return NextResponse.json({ accepted: true, mode: 'chain', chain, timestamp: new Date().toISOString() })
  }

  try {
    const result = await runCheckBatch({ limit, chain: 0, prevRemaining, stall, origin })
    return NextResponse.json(result)
  } catch (e) {
    if (e instanceof QuotaExhaustedError) {
      return NextResponse.json(
        { error: e.message, quotaExhausted: true, processed: 0 },
        { status: 429 }
      )
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
