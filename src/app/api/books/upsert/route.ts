import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// GET: スケジュールタスクからの書籍upsert（WebFetchはGETのみ対応のため）
// 使用例: /api/books/upsert?isbn=XXX&title=XXX&author=XXX&publisher=XXX&release_date=YYYY-MM-DD&c_code=XXXX&genre=XXX&rank=高確率&sns_json=BASE64&source=jpro&evaluation_reason=XXX
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  // 必須パラメータ
  const title = searchParams.get('title')
  const author = searchParams.get('author')

  if (!title || !author) {
    return NextResponse.json(
      { error: 'title and author are required' },
      { status: 400 }
    )
  }

  // オプションパラメータ
  const isbn = searchParams.get('isbn') || null
  const publisher = searchParams.get('publisher') || null
  const release_date = searchParams.get('release_date') || null
  const c_code = searchParams.get('c_code') || null
  const genre = searchParams.get('genre') || null
  const rank = searchParams.get('rank') || null
  const status = searchParams.get('status') || '未対応'
  const source = searchParams.get('source') || 'jpro'
  const evaluation_reason = searchParams.get('evaluation_reason') || null
  const price_str = searchParams.get('price')
  const price = price_str ? parseInt(price_str, 10) : null

  // SNSデータ: Base64エンコードされたJSON文字列
  let sns_data = {}
  const sns_json = searchParams.get('sns_json')
  if (sns_json) {
    try {
      const decoded = Buffer.from(sns_json, 'base64').toString('utf-8')
      sns_data = JSON.parse(decoded)
    } catch {
      // パース失敗時は空オブジェクト
      sns_data = {}
    }
  }

  const bookData = {
    title,
    author,
    publisher,
    isbn,
    price,
    release_date,
    c_code,
    genre,
    rank,
    status,
    sns_data,
    evaluation_reason,
    source,
  }

  // ISBNがある場合はISBNで重複チェック、なければtitle+authorで重複チェック
  let existingBook = null
  if (isbn) {
    const { data } = await supabase
      .from('books')
      .select('id')
      .eq('isbn', isbn)
      .maybeSingle()
    existingBook = data
  } else {
    const { data } = await supabase
      .from('books')
      .select('id')
      .eq('title', title)
      .eq('author', author)
      .maybeSingle()
    existingBook = data
  }

  if (existingBook) {
    // 既存レコードを更新（statusは既存を維持、他のフィールドを更新）
    const updateData = { ...bookData }
    delete (updateData as Record<string, unknown>).status // ステータスは手動管理なので上書きしない

    const { data, error } = await supabase
      .from('books')
      .update(updateData)
      .eq('id', existingBook.id)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ action: 'updated', book: data })
  } else {
    // 新規追加
    const { data, error } = await supabase
      .from('books')
      .insert(bookData)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ action: 'created', book: data }, { status: 201 })
  }
}
