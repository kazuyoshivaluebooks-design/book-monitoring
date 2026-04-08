import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import * as cheerio from 'cheerio'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // Vercel Pro: 60s, Hobby: 10s

// 除外ジャンルのキーワード
const EXCLUDED_KEYWORDS = [
  'コミック', '漫画', 'まんが', 'マンガ', 'ライトノベル',
  '写真集', 'グラビア', '児童書', '絵本', '雑誌', 'ムック',
  '学習参考書', '問題集', 'ドリル', 'アダルト', 'BL', 'TL',
  'ボーイズラブ', 'ティーンズラブ', 'ゲーム攻略',
  'ぬりえ', 'パズル', 'クロスワード', '楽譜',
]

// C-code 除外パターン（雑誌、コミック、児童）
const EXCLUDED_CCODE_PREFIXES = ['8', '97', '87']

// ジャンル・C-code による除外判定
function shouldExclude(title: string, cCode: string | null, genre: string | null): boolean {
  const text = `${title} ${genre || ''}`.toLowerCase()
  if (EXCLUDED_KEYWORDS.some(kw => text.includes(kw.toLowerCase()))) return true
  if (cCode && EXCLUDED_CCODE_PREFIXES.some(p => cCode.startsWith(p))) return true
  return false
}

// 版元ドットコムの近刊ページをスクレイプ
async function fetchHanmotoBooks(page = 1): Promise<Array<{
  title: string
  author: string
  publisher: string
  isbn: string | null
  releaseDate: string | null
  cCode: string | null
}>> {
  const url = page === 1
    ? 'https://www.hanmoto.com/bd/search/order/firing/dkey1/near'
    : `https://www.hanmoto.com/bd/search/order/firing/dkey1/near/page/${page}`

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; BookMonitor/1.0)',
    },
    signal: AbortSignal.timeout(8000),
  })

  if (!res.ok) throw new Error(`hanmoto.com returned ${res.status}`)

  const html = await res.text()
  const $ = cheerio.load(html)
  const books: Array<{
    title: string
    author: string
    publisher: string
    isbn: string | null
    releaseDate: string | null
    cCode: string | null
  }> = []

  // 版元ドットコムの検索結果をパース
  // 各書籍は .result-item や .book-list-item 等の要素にある
  $('div.block--booksearch-data, div.result-item, tr.even, tr.odd, .book-data').each((_i, el) => {
    const $el = $(el)
    const text = $el.text()

    // タイトル取得
    const titleEl = $el.find('a[href*="/bd/isbn/"], h3, .title, td:first-child a')
    let title = titleEl.first().text().trim()
    if (!title) return

    // 著者取得
    const authorText = $el.find('.author, td:nth-child(2)').first().text().trim()
    const author = authorText || ''

    // 出版社取得
    const publisherText = $el.find('.publisher, td:nth-child(3)').first().text().trim()
    const publisher = publisherText || ''

    // ISBN取得
    const isbnMatch = text.match(/(?:ISBN[:\s]?)?(97[89][-\s]?\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,7}[-\s]?\d)/)
    const isbn = isbnMatch ? isbnMatch[1].replace(/[-\s]/g, '') : null

    // 発売日取得
    const dateMatch = text.match(/(\d{4})[年\/\-](\d{1,2})[月\/\-](\d{1,2})/)
    const releaseDate = dateMatch
      ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
      : null

    // Cコード取得
    const cCodeMatch = text.match(/C(\d{4})/)
    const cCode = cCodeMatch ? cCodeMatch[1] : null

    if (title && author) {
      books.push({ title, author, publisher, isbn, releaseDate, cCode })
    }
  })

  // もしパースできなかった場合、テキストベースのフォールバック
  if (books.length === 0) {
    // ページ全体からリンク付き書籍を探す
    $('a[href*="/bd/isbn/"]').each((_i, el) => {
      const title = $(el).text().trim()
      if (title && title.length > 2 && title.length < 100) {
        const parentText = $(el).closest('tr, div, li').text()
        const authorMatch = parentText.match(/(?:著|著者|作)[：:\s]*([^\s,、]+(?:\s+[^\s,、]+)?)/)
        const author = authorMatch ? authorMatch[1] : ''
        const pubMatch = parentText.match(/(?:出版社|版元)[：:\s]*([^\s,、]+)/)
        const publisher = pubMatch ? pubMatch[1] : ''
        const isbnMatch = parentText.match(/(97[89]\d{10})/)
        const isbn = isbnMatch ? isbnMatch[1] : null
        const dateMatch = parentText.match(/(\d{4})[年\/\-](\d{1,2})[月\/\-](\d{1,2})/)
        const releaseDate = dateMatch
          ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
          : null
        const cCodeMatch = parentText.match(/C(\d{4})/)
        const cCode = cCodeMatch ? cCodeMatch[1] : null

        if (title && author) {
          books.push({ title, author, publisher, isbn, releaseDate, cCode })
        }
      }
    })
  }

  return books
}

// メインの処理
export async function GET(request: NextRequest) {
  // cron認証（Vercelのcron secretまたはAPIキー）
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const results = {
    scrapedBooks: 0,
    filteredOut: 0,
    alreadyExists: 0,
    newlyRegistered: 0,
    errors: [] as string[],
    newBooks: [] as Array<{ title: string; author: string; publisher: string; rank: string }>,
  }

  try {
    // 1. 版元ドットコムから書籍を取得（1ページ目）
    let allBooks: Awaited<ReturnType<typeof fetchHanmotoBooks>> = []
    try {
      allBooks = await fetchHanmotoBooks(1)
      results.scrapedBooks = allBooks.length
    } catch (e) {
      results.errors.push(`版元ドットコム取得エラー: ${e instanceof Error ? e.message : String(e)}`)
      return NextResponse.json(results, { status: 500 })
    }

    // 2. ジャンルフィルタリング
    const filteredBooks = allBooks.filter(book => {
      if (shouldExclude(book.title, book.cCode, null)) {
        results.filteredOut++
        return false
      }
      return true
    })

    // 3. 既存書籍の確認
    const { data: existingBooks } = await supabase
      .from('books')
      .select('isbn, title, author')

    const existingIsbns = new Set(
      (existingBooks || [])
        .map(b => b.isbn)
        .filter((isbn): isbn is string => isbn !== null)
    )
    const existingTitles = new Set(
      (existingBooks || []).map(b => `${b.title}|${b.author}`)
    )

    // 4. 新規書籍のみ抽出
    const newBooks = filteredBooks.filter(book => {
      if (book.isbn && existingIsbns.has(book.isbn)) {
        results.alreadyExists++
        return false
      }
      if (existingTitles.has(`${book.title}|${book.author}`)) {
        results.alreadyExists++
        return false
      }
      return true
    })

    // 5. 新規書籍を登録（rank は "調査待ち" として仮登録）
    for (const book of newBooks) {
      try {
        const { error } = await supabase.from('books').insert({
          title: book.title,
          author: book.author,
          publisher: book.publisher || null,
          isbn: book.isbn,
          release_date: book.releaseDate,
          c_code: book.cCode,
          rank: null,
          status: '未対応',
          sns_data: {},
          evaluation_reason: '自動検出 - SNS調査待ち',
          source: '版元ドットコム',
        })

        if (error) {
          results.errors.push(`登録エラー (${book.title}): ${error.message}`)
        } else {
          results.newlyRegistered++
          results.newBooks.push({
            title: book.title,
            author: book.author,
            publisher: book.publisher,
            rank: '調査待ち',
          })
        }
      } catch (e) {
        results.errors.push(`登録エラー (${book.title}): ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // 6. Slack通知（SLACK_WEBHOOK_URLが設定されている場合）
    const slackWebhook = process.env.SLACK_WEBHOOK_URL
    if (slackWebhook && results.newlyRegistered > 0) {
      try {
        const bookList = results.newBooks
          .map(b => `・『${b.title}』${b.author}（${b.publisher}）`)
          .join('\n')

        await fetch(slackWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `📚 新刊自動検出（${new Date().toLocaleDateString('ja-JP')}）\n\n`
              + `【新規発見: ${results.newlyRegistered}冊】\n${bookList}\n\n`
              + `※ SNS調査・ランク付けは未完了です\n`
              + `ダッシュボード: https://book-monitoring.vercel.app/`,
          }),
        })
      } catch {
        results.errors.push('Slack通知送信エラー')
      }
    }

    const elapsed = Date.now() - startTime
    return NextResponse.json({
      ...results,
      elapsedMs: elapsed,
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    results.errors.push(`全体エラー: ${e instanceof Error ? e.message : String(e)}`)
    return NextResponse.json(results, { status: 500 })
  }
}
