/**
 * GET /api/backfill-biblon?limit=100
 *
 * 既存書籍で cover_url が空のものに Biblon API からバッチで書誌情報をバックフィル。
 * fetchBooksBatch を使って一括取得し、高速化。
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { fetchBooksBatch } from '@/lib/biblon'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

export async function GET(request: NextRequest) {
  const limit = parseInt(request.nextUrl.searchParams.get('limit') || '100', 10)
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
    .limit(Math.min(limit, 500))

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!books || books.length === 0) {
    return NextResponse.json({ message: 'バックフィル対象なし', updated: 0 })
  }

  let updated = 0
  let skipped = 0
  const errors: string[] = []

  // ISBNリスト作成（重複排除）
  const isbnToIds = new Map<string, string[]>()
  for (const book of books) {
    if (!book.isbn) continue
    const existing = isbnToIds.get(book.isbn) || []
    existing.push(book.id)
    isbnToIds.set(book.isbn, existing)
  }

  // バッチで100件ずつBiblon APIに問い合わせ
  const allIsbns = Array.from(isbnToIds.keys())
  const BATCH_SIZE = 100

  for (let i = 0; i < allIsbns.length; i += BATCH_SIZE) {
    if (Date.now() - startTime > 7000) {
      errors.push(`タイムアウト: ${allIsbns.length - i}件未処理`)
      break
    }

    const batchIsbns = allIsbns.slice(i, i + BATCH_SIZE)

    try {
      const biblonBooks = await fetchBooksBatch(batchIsbns, biblonApiKey)

      // ISBN → Biblonデータのマップ
      const biblonMap = new Map(biblonBooks.map(b => [b.isbn, b]))

      // 各書籍を更新
      for (const isbn of batchIsbns) {
        const biblon = biblonMap.get(isbn)
        const bookIds = isbnToIds.get(isbn) || []

        if (!biblon) {
          // Biblonにデータなし → cover_urlに空文字を入れて再処理対象から外す
          for (const id of bookIds) {
            await supabase.from('books').update({ cover_url: '' }).eq('id', id)
          }
          skipped += bookIds.length
          continue
        }

        const updateData: Record<string, unknown> = {}
        if (biblon.coverUrl) updateData.cover_url = biblon.coverUrl
        if (biblon.description) updateData.description = biblon.description
        if (biblon.pages) updateData.pages = biblon.pages

        if (Object.keys(updateData).length === 0) {
          for (const id of bookIds) {
            await supabase.from('books').update({ cover_url: '' }).eq('id', id)
          }
          skipped += bookIds.length
          continue
        }

        for (const id of bookIds) {
          const { error: updateError } = await supabase
            .from('books')
            .update(updateData)
            .eq('id', id)

          if (updateError) {
            errors.push(`${isbn}: ${updateError.message}`)
          } else {
            updated++
          }
        }
      }
    } catch (e) {
      errors.push(`バッチエラー: ${e instanceof Error ? e.message : String(e)}`)
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
