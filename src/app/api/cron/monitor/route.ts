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
  if (cCode) {
    // Cコード先頭が 8（雑誌）、97（コミック）、87（児童向けコミック）
    if (EXCLUDED_CCODE_PREFIXES.some(p => cCode.startsWith(p))) return true
    // Cコード2桁目が 7 = コミック（C_7__）、8 = 雑誌（C_8__）
    if (cCode.length === 4 && (cCode[1] === '7' || cCode[1] === '8')) return true
  }
  return false
}

type BookData = {
  title: string
  author: string
  publisher: string
  isbn: string | null
  releaseDate: string | null
  cCode: string | null
  genre: string | null
  price: number | null
}

// 版元ドットコムの新刊・近刊ページをスクレイプ
async function fetchHanmotoBooks(path: string): Promise<BookData[]> {
  const url = `https://www.hanmoto.com${path}`

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en;q=0.9',
    },
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) throw new Error(`hanmoto.com returned ${res.status} for ${path}`)

  const html = await res.text()
  const $ = cheerio.load(html)
  const books: BookData[] = []

  // 各書籍は li.bd-booklist-item-book
  $('li.bd-booklist-item-book').each((_i, el) => {
    const $el = $(el)

    // タイトル取得: .book-title h4 span（ルビ読みをカッコ内で除去）
    const titleSpan = $el.find('.book-title h4 span').first()
    const title = titleSpan.text().replace(/\s*[（(][^）)]*[）)]\s*/g, '').trim()
    if (!title) return

    // 著者取得: .book-author 要素（ルビ読みをカッコ内で除去）
    const authorEls = $el.find('.book-author')
    const authors = authorEls.map((_j, a) =>
      $(a).text().replace(/\s*[（(][^）)]*[）)]\s*/g, '').trim()
    ).get().filter(Boolean)
    const author = authors.join(', ')
    if (!author) return

    // 出版社取得: .book-publishers のテキストから「発行：」を除去
    const pubText = $el.find('.book-publishers').text()
    const publisher = pubText
      .replace(/発行[：:]\s*/, '')
      .replace(/\s*[（(][^）)]*[）)]\s*/g, '')
      .replace(/会員の本/g, '')
      .trim()

    // ISBN取得: タイトルリンクの href（/bd/isbn/XXXXX）
    const titleLink = $el.find('.bd-list-book-col-contents > a').first()
    const href = titleLink.attr('href') || ''
    const isbnFromHref = href.match(/\/bd\/isbn\/(\d{13})/)
    let isbn = isbnFromHref ? isbnFromHref[1] : null
    // フォールバック: テキストからISBNを探す
    if (!isbn) {
      const fullText = $el.text()
      const isbnMatch = fullText.match(/ISBN[：:\s]*([0-9-]+)/)
      if (isbnMatch) {
        isbn = isbnMatch[1].replace(/[-\s]/g, '')
        if (isbn.length !== 13) isbn = null
      }
    }

    // Cコード取得
    const fullText = $el.text()
    const cCodeMatch = fullText.match(/Cコード[：:\s]*(\d{4})/)
    const cCode = cCodeMatch ? cCodeMatch[1] : null

    // ジャンル取得
    const genreEl = $el.find('.book-mark-genre')
    const genre = genreEl.text().trim() || null

    // 発売日取得: 「書店発売日:」パターン
    const dateMatch = fullText.match(/書店発売日[：:\s]*(\d{4})年(\d{1,2})月(\d{1,2})日/)
    const releaseDate = dateMatch
      ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
      : null

    // 価格取得: 「定価:」パターン
    const priceMatch = fullText.match(/定価[：:\s]*([\d,]+)円/)
    const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''), 10) : null

    books.push({ title, author, publisher, isbn, releaseDate, cCode, genre, price })
  })

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

  // デバッグモード: ?debug=1 でHTMLの一部を返す
  const debug = request.nextUrl.searchParams.get('debug')
  if (debug) {
    try {
      const testPath = '/bd/shinkan/today'
      const testUrl = `https://www.hanmoto.com${testPath}`
      const res = await fetch(testUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en;q=0.9',
        },
        signal: AbortSignal.timeout(15000),
      })
      const html = await res.text()
      const $ = cheerio.load(html)
      const itemCount = $('li.bd-booklist-item-book').length
      const bodyClasses = $('body').attr('class') || 'none'
      const title = $('title').text()
      // Check for hanmotocom-data script tag (contains book list as JSON)
      const dataScript = $('#hanmotocom-data').html()
      let hanmotoData = null
      let bookListCount = 0
      let firstBooks: Array<{ isbn: string; uniq: string }> = []
      if (dataScript) {
        try {
          hanmotoData = JSON.parse(dataScript)
          const list = hanmotoData?.booklist?.list || []
          bookListCount = list.length
          firstBooks = list.slice(0, 5).map((b: { isbn: string; uniq: string }) => ({ isbn: b.isbn, uniq: b.uniq }))
        } catch { /* ignore */ }
      }
      return NextResponse.json({
        url: testUrl,
        status: res.status,
        htmlLength: html.length,
        pageTitle: title,
        hasHanmotoData: !!dataScript,
        hanmotoDataLength: dataScript?.length || 0,
        bookListCount,
        firstBooks,
        terms: hanmotoData?.booklist?.terms || null,
      })
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 })
    }
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
    // 1. 版元ドットコムから書籍を取得
    //    - 本日発売の本 + 明日発売の本 + 1週間以内に発売される本
    let allBooks: BookData[] = []
    const paths = [
      '/bd/shinkan/today',      // 本日発売
      '/bd/kinkan/tomorrow',    // 明日発売
      '/bd/kinkan/7days',       // 1週間以内に発売
    ]
    for (const path of paths) {
      try {
        const books = await fetchHanmotoBooks(path)
        allBooks.push(...books)
      } catch (e) {
        results.errors.push(`取得エラー (${path}): ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // ISBN でユニーク化（同じ本が複数リストに出る可能性）
    const seen = new Set<string>()
    allBooks = allBooks.filter(book => {
      const key = book.isbn || `${book.title}|${book.author}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    results.scrapedBooks = allBooks.length

    if (allBooks.length === 0 && results.errors.length > 0) {
      return NextResponse.json(results, { status: 500 })
    }

    // 2. ジャンルフィルタリング
    const filteredBooks = allBooks.filter(book => {
      if (shouldExclude(book.title, book.cCode, book.genre)) {
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
          price: book.price,
          release_date: book.releaseDate,
          c_code: book.cCode,
          genre: book.genre,
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
