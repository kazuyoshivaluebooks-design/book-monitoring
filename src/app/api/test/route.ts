import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const action = searchParams.get('action')
  return NextResponse.json({
    message: 'test route working',
    action,
    url: request.url,
    allParams: Object.fromEntries(searchParams.entries()),
    timestamp: new Date().toISOString(),
  })
}
