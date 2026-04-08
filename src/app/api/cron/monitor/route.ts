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
    if (EXCLUDED_CCODE_PREFIXES.some(p => cCode.startsWith(p))) return true
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

// ==============================
// Step 1: 版元ドットコムから ISBN リストを取得
// （サーバーサイド HTML 内の <script id="hanmotocom-data"> を解析）
// ==============================
async function fetchHanmotoIsbns(path: string): Promise<string[]> {
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

  // <script id="hanmotocom-data"> 内の JSON を解析
  const dataScript = $('#hanmotocom-data').html()
  if (!dataScript) return []

  try {
    const data = JSON.parse(dataScript)
    const list: Array<{ isbn: string; uniq: string }> = data?.booklist?.list || []
    return list
      .map(item => item.isbn)
      .filter((isbn): isbn is string => !!isbn && isbn.length === 13)
  } catch {
    return []
  }
}

// ==============================
// Step 2: openBD API で書籍の詳細情報を取得
// （最大1000件をカンマ区切りで一括取得可能）
// ==============================
type OpenBDBook = {
  onix?: {
    DescriptiveDetail?: {
      TitleDetail?: {
        TitleElement?: {
          TitleText?: { content?: string }
          Subtitle?: { content?: string }
        }
      }
      Contributor?: Array<{
        PersonName?: { content?: string }
        ContributorRole?: string[]
      }>
      Subject?: Array<{
        SubjectSchemeIdentifier?: string
        SubjectCode?: string
      }>
    }
    PublishingDetail?: {
      Imprint?: { ImprintName?: string }
      Publisher?: { PublisherName?: string }
      PublishingDate?: Array<{
        PublishingDateRole?: string
        Date?: string
      }>
    }
    ProductSupply?: {
      SupplyDetail?: {
        Price?: Array<{
          PriceAmount?: string
        }>
      }
    }
  }
  summary?: {
    isbn?: string
    title?: string
    author?: string
    publisher?: string
    pubdate?: string
  }
}

function parseOpenBDBook(book: OpenBDBook): BookData | null {
  if (!book) return null

  const summary = book.summary
  if (!summary?.title) return null

  const title = summary.title
  const author = summary.author || ''
  const publisher = summary.publisher || ''
  const isbn = summary.isbn || null

  // 発売日: summary.pubdate (YYYYMMDD) → YYYY-MM-DD
  let releaseDate: string | null = null
  if (summary.pubdate && summary.pubdate.length === 8) {
    releaseDate = `${summary.pubdate.slice(0, 4)}-${summary.pubdate.slice(4, 6)}-${summary.pubdate.slice(6, 8)}`
  }

  // Cコード: Subject の SubjectSchemeIdentifier="78" → SubjectCode
  let cCode: string | null = null
  const subjects = book.onix?.DescriptiveDetail?.Subject || []
  for (const subj of subjects) {
    if (subj.SubjectSchemeIdentifier === '78' && subj.SubjectCode) {
      cCode = subj.SubjectCode
      break
    }
  }

  // ジャンル: Subject の SubjectSchemeIdentifier="79" → SubjectCode
  let genre: string | null = null
  for (const subj of subjects) {
    if (subj.SubjectSchemeIdentifier === '79' && subj.SubjectCode) {
      genre = subj.SubjectCode
      break
    }
  }

  // 価格
  let price: number | null = null
  const prices = book.onix?.ProductSupply?.SupplyDetail?.Price || []
  if (prices.length > 0 && prices[0].PriceAmount) {
    price = parseInt(prices[0].PriceAmount, 10)
  }

  return { title, author, publisher, isbn, releaseDate, cCode, genre, price }
}

async function fetchOpenBDBooks(isbns: string[]): Promise<BookData[]> {
  if (isbns.length === 0) return []

  // openBD は最大1000件まで一括取得可能
  const batchSize = 100
  const results: BookData[] = []

  for (let i = 0; i < isbns.length; i += batchSize) {
    const batch = isbns.slice(i, i + batchSize)
    const url = `https://api.openbd.jp/v1/get?isbn=${batch.join(',')}`

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) continue

      const data: (OpenBDBook | null)[] = await res.json()
      for (const item of data) {
        if (!item) continue
        const book = parseOpenBDBook(item)
        if (book) results.push(book)
      }
    } catch {
      // openBD エラーは無視して続行
    }
  }

  return results
}

// ==============================
// メインの処理
// ==============================
export async function GET(request: NextRequest) {
  // cron認証（Vercelのcron secretまたはAPIキー）
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const results = {
    scrapedIsbns: 0,
    openBDResolved: 0,
    filteredOut: 0,
    alreadyExists: 0,
    newlyRegistered: 0,
    errors: [] as string[],
    newBooks: [] as Array<{ title: string; author: string; publisher: string; rank: string }>,
  }

  try {
    // 1. 版元ドットコムから ISBN を収集
    const paths = [
      '/bd/shinkan/today',      // 本日発売
      '/bd/kinkan/tomorrow',    // 明日発売
      '/bd/kinkan/7days',       // 1週間以内に発売
    ]

    const allIsbns = new Set<string>()
    for (const path of paths) {
      try {
        const isbns = await fetchHanmotoIsbns(path)
        isbns.forEach(isbn => allIsbns.add(isbn))
      } catch (e) {
        results.errors.push(`ISBN取得エラー (${path}): ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    results.scrapedIsbns = allIsbns.size

    if (allIsbns.size === 0 && results.errors.length > 0) {
      return NextResponse.json(results, { status: 500 })
    }

    // 2. openBD API で書籍の詳細情報を取得
    const allBooks = await fetchOpenBDBooks(Array.from(allIsbns))
    results.openBDResolved = allBooks.length

    // 3. ジャンルフィルタリング
    const filteredBooks = allBooks.filter(book => {
      if (shouldExclude(book.title, book.cCode, book.genre)) {
        results.filteredOut++
        return false
      }
      return true
    })

    // 4. 既存書籍の確認
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

    // 5. 新規書籍のみ抽出
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

    // 6. 新規書籍を登録（rank は null = "調査待ち" として仮登録）
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
          source: '版元ドットコム + openBD',
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

    // 7. Slack通知（SLACK_WEBHOOK_URLが設定されている場合）
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
