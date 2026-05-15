/**
 * GET /api/backfill-biblon?limit=50
 *
 * 既存書籍で description / cover_url / pages が空のものに
 * Biblon API から書誌情報をバックフィルする。
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { fetchBookByIsbn } from '@/lib/biblon'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

export async function GET(request: NextRequest) {
  const limit = parseInt(request.nextUrl.searchParams.get('limit') || '50', 10)
  const biblonApiKey = process.env.BIBLON_API_KEY
  if (!biblonApiKey) {
    return NextResponse.json({ error: 'BIBLON_API_KEY未設定' }, { status: 500 })
  }

  const startTime = Date.now()

  // cover_url が null かつ isbn がある書籍を取得
  const { data: books, error } = await supabase
    .from('books')
    .select('id, isbn')
    .is('cover_url', null)
    .not('isbn', 'is', null)
    .limit(Math.min(limit, 100))

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!books || books.length === 0) {
    return NextResponse.json({ message: 'バックフィル対象なし', updated: 0 })
  }

  let updated = 0
  let skipped = 0
  const errors: string[] = []

  for (const book of books) {
    if (Date.now() - startTime > 8000) {
      errors.push(`タイムアウト: ${books.length - updated - skipped}件未処理`)
      break
    }

    try {
      const biblon = await fetchBookByIsbn(book.isbn, biblonApiKey)
      if (!biblon) {
        skipped++
        continue
      }

      const updateData: Record<string, unknown> = {}
      if (biblon.coverUrl) updateData.cover_url = biblon.coverUrl
      if (biblon.description) updateData.description = biblon.description
      if (biblon.pages) updateData.pages = biblon.pages

      if (Object.keys(updateData).length === 0) {
        // Biblonにもデータがない場合、cover_urlに空文字を入れて再処理対象から外す
        await supabase.from('books').update({ cover_url: '' }).eq('id', book.id)
        skipped++
        continue
      }

      const { error: updateError } = await supabase
        .from('books')
        .update(updateData)
        .eq('id', book.id)

      if (updateError) {
        errors.push(`${book.isbn}: ${updateError.message}`)
      } else {
        updated++
      }
    } catch (e) {
      errors.push(`${book.isbn}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 残り件数
  const { count: remaining } = await supabase
    .from('books')
    .select('id', { count: 'exact', head: true })
    .is('cover_url', null)
    .not('isbn', 'is', null)

  return NextResponse.json({
    updated,
    skipped,
    remaining: remaining || 0,
    errors,
    elapsedMs: Date.now() - startTime,
  })
}
