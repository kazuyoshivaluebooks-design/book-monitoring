import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

// GET /api/cron/sns-batch
//
// 外部cronサービス（cron-job.org等）から5分おきに呼び出す用のエンドポイント。
// 内部で /api/sns/check を呼び出して未調査書籍を処理する。
//
// 使い方:
//   1. cron-job.org でアカウント作成（無料）
//   2. URL: https://your-app.vercel.app/api/cron/sns-batch?token=YOUR_CRON_SECRET
//   3. スケジュール: every 5 minutes
//   4. 環境変数 CRON_SECRET を Vercel に設定
//
// これにより:
//   - 5分おき x 1冊/回 = 288冊/日 の自動処理が可能
//   - Vercel Hobby plan の cron制限（1日1回）を回避

export async function GET(request: NextRequest) {
  // 認証チェック
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const token = request.nextUrl.searchParams.get('token')
    const authHeader = request.headers.get('authorization')
    if (token !== cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const startTime = Date.now()

  try {
    // 内部でsns/checkエンドポイントのロジックを直接呼ぶ代わりに
    // fetch で自分自身を呼ぶ（コード重複を避ける）
    const baseUrl = request.nextUrl.origin
    const res = await fetch(`${baseUrl}/api/sns/check?limit=2`, {
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({
        error: `sns/check returned ${res.status}`,
        detail: text.slice(0, 200),
        elapsedMs: Date.now() - startTime,
      }, { status: res.status })
    }

    const data = await res.json()

    return NextResponse.json({
      ...data,
      source: 'cron/sns-batch',
      elapsedMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : String(e),
      source: 'cron/sns-batch',
      elapsedMs: Date.now() - startTime,
    }, { status: 500 })
  }
}
