import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// GET: 登録済みISBN一覧を取得（差分チェック用）
// レスポンス: { isbns: ["978-...", ...], titles: ["書名|著者", ...], count: 123 }
export async function GET() {
  const { data, error } = await supabase
    .from('books')
    .select('isbn, title, author')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const isbns = data
    .map((b) => b.isbn)
    .filter((isbn): isbn is string => isbn !== null)

  const titles = data.map((b) => `${b.title}|${b.author}`)

  return NextResponse.json({
    isbns,
    titles,
    count: data.length,
  })
}
