/**
 * Biblon API クライアント
 *
 * ValueBooks の書籍カタログサービス Biblon から書誌情報を取得する。
 * JPRO・日販のデータを一元管理しており、版元ドットコム + openBD より精度が高い。
 *
 * API ドキュメント: https://biblon-dev.valuebooks.jp/userguide-jp.html
 * 環境変数: BIBLON_API_KEY
 */

const BIBLON_BASE_URL = 'https://biblon-dev.valuebooks.jp'

export type BiblonBook = {
  catalogId: string
  isbn: string
  title: string
  author: string
  publisher: string
  year: number | null
  pages: number | null
  price: number | null
  coverUrl: string
  description: string
  cCode: string
  source: string  // jpro | nippan | api | openbd | google_books
  score: number
}

/**
 * Biblon API で書籍を検索
 */
async function biblonFetch(
  endpoint: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<BiblonBook[]> {
  const res = await fetch(`${BIBLON_BASE_URL}${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
    },
    signal,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Biblon API ${res.status}: ${body.slice(0, 200)}`)
  }

  return res.json()
}

/**
 * 出版日の範囲で新刊を取得（ページネーション自動処理）
 *
 * @param publishedFrom YYYY-MM-DD（この日を含む）
 * @param publishedTo   YYYY-MM-DD（この日を含む）
 * @param apiKey        Biblon API キー
 * @returns 全件の配列
 */
export async function fetchUpcomingBooks(
  publishedFrom: string,
  publishedTo: string,
  apiKey: string
): Promise<BiblonBook[]> {
  const allBooks: BiblonBook[] = []
  const PAGE_SIZE = 100
  let offset = 0
  const MAX_OFFSET = 9900 // offset + limit ≤ 10000

  while (offset <= MAX_OFFSET) {
    const params = new URLSearchParams({
      published_from: publishedFrom,
      published_to: publishedTo,
      sort: 'published_date:asc',
      limit: String(PAGE_SIZE),
      offset: String(offset),
    })

    const books = await biblonFetch(
      `/api/books/search?${params}`,
      apiKey,
      AbortSignal.timeout(10000)
    )

    allBooks.push(...books)

    // 取得件数がPAGE_SIZE未満なら最後のページ
    if (books.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return allBooks
}

/**
 * ISBN で書籍を個別取得
 */
export async function fetchBookByIsbn(
  isbn: string,
  apiKey: string
): Promise<BiblonBook | null> {
  try {
    const books = await biblonFetch(
      `/api/books/search?q=${isbn}`,
      apiKey,
      AbortSignal.timeout(5000)
    )
    return books.find(b => b.isbn === isbn) || books[0] || null
  } catch {
    return null
  }
}

/**
 * ISBN 一括取得
 */
export async function fetchBooksBatch(
  isbns: string[],
  apiKey: string
): Promise<BiblonBook[]> {
  const res = await fetch(`${BIBLON_BASE_URL}/api/books/batch`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ isbns }),
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) {
    throw new Error(`Biblon batch API ${res.status}`)
  }

  return res.json()
}
