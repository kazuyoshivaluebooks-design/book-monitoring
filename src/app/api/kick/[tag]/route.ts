import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

/**
 * GET /api/kick/{tag}?chain=300&target=check
 *
 * 自走ループの起動用エンドポイント。
 * /api/sns/check（または rerank）を chain 付きで1回蹴り、即座に返る。
 * 蹴られた側は処理完了時に自分自身を chain-1 で呼び直すため、
 * 残数がゼロになるまでサーバー側だけで処理が回り続ける。
 *
 * {tag} はキャッシュ回避用（呼び出しごとに異なる値を入れる）。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tag: string }> }
) {
  const { tag } = await params
  const sp = request.nextUrl.searchParams
  const chain = Math.min(Math.max(parseInt(sp.get('chain') || '300', 10), 0), 2000)
  const target = sp.get('target') === 'rerank' ? 'rerank' : 'check'
  const limit = target === 'check' ? '5' : '3'

  const origin = request.nextUrl.origin
  const url = `${origin}/api/sns/${target}?limit=${limit}&chain=${chain}&t=${Date.now()}`

  // 送信だけして応答は待たない（1.5秒でabortしてもサーバー側の処理は完走する）
  let dispatched = true
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) })
  } catch {
    dispatched = true  // タイムアウトabortは送信成功とみなす
  }

  return NextResponse.json({
    tag,
    kicked: target,
    chain,
    dispatched,
    timestamp: new Date().toISOString(),
  })
}
