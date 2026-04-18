import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import * as cheerio from 'cheerio'

// 日付ヘルパー: YYYY-MM-DD
function toDateStr(date: Date): string {
  return date.toISOString().split('T')[0]
}
function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

export const dynamic = 'force-dynamic'
export const maxDuration = 10 // Vercel Hobby: 10s

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

type HanmotoListItem = {
  isbn: string
  uniq: string
  lastupdated: string
  shortcode: string
  hanmoto_lastupdated: string
}

// ==============================
// Step 1: 版元ドットコムの query.json API で ISBN リストを取得
// POST /bd/list/query.json で日付範囲・offset・rowmax を指定
// ==============================
async function fetchHanmotoByDateRange(
  from: string, to: string, offset = 0, rowmax = 100
): Promise<HanmotoListItem[]> {
  const url = 'https://www.hanmoto.com/bd/list/query.json'
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.hanmoto.com/bd/kinkan/60days',
      'Origin': 'https://www.hanmoto.com',
    },
    body: JSON.stringify({
      conds: { salesdate: { from, to } },
      categoryname: 'kinkan/60days',
      part: 'kinkan/60days',
      offset,
      rowmax,
    }),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`query.json returned ${res.status}`)

  const json = await res.json()
  if (!json.result) throw new Error(`query.json error: ${json.error?.message || 'unknown'}`)

  const list: HanmotoListItem[] = json.data?.list || []
  return list.filter(item => !!item.isbn && item.isbn.length === 13)
}

// 旧方式のHTMLスクレイピング（フォールバック用）
async function fetchHanmotoList(path: string): Promise<HanmotoListItem[]> {
  const url = `https://www.hanmoto.com${path}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`hanmoto.com returned ${res.status} for ${path}`)
  const html = await res.text()
  const $ = cheerio.load(html)
  const dataScript = $('#hanmotocom-data').html()
  if (!dataScript) return []
  try {
    const data = JSON.parse(dataScript)
    const list: HanmotoListItem[] = data?.booklist?.list || []
    return list.filter(item => !!item.isbn && item.isbn.length === 13)
  } catch { return [] }
}

// ==============================
// Step 2: 版元ドットコムの book JSON API で個別書籍詳細を取得
// URL: /bd/book/uniqs/{u1}/{u2}/{u3}/book.{hash}.{timestamp}.json
// → dates.sales で発売日、titles.title.text でタイトルなど
// ==============================
type HanmotoBookDetail = {
  title: string
  author: string
  publisher: string
  isbn: string
  releaseDate: string | null
  price: number | null
}

async function fetchHanmotoBookDetail(item: HanmotoListItem): Promise<HanmotoBookDetail | null> {
  try {
    const url = `https://www.hanmoto.com/bd/isbn/${item.isbn}`
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return null

    const html = await res.text()
    const $ = cheerio.load(html)

    // タイトル: <span itemprop="name">
    const title = $('span[itemprop="name"]').first().text().trim()
      || $('h1').first().text().trim()
    if (!title) return null

    // 著者: <span itemprop="author">
    const author = $('span[itemprop="author"]').map((_, el) => $(el).text().trim()).get().join(' ')
      || ''

    // 出版社: <span itemprop="publisher">
    const publisher = $('span[itemprop="publisher"]').first().text().trim()
      || ''

    // 発売日: <dd class="book-dates-sales" content="2026-06-17">
    let releaseDate: string | null = null
    const salesEl = $('dd.book-dates-sales')
    if (salesEl.length > 0) {
      const content = salesEl.attr('content')
      if (content && /^\d{4}-\d{2}-\d{2}$/.test(content)) {
        releaseDate = content
      } else {
        const text = salesEl.text().trim()
        const match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
        if (match) {
          releaseDate = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
        }
      }
    }
    if (!releaseDate) {
      const dateEl = $('[itemprop="datePublished"]')
      const content = dateEl.attr('content')
      if (content && /^\d{4}-\d{2}-\d{2}$/.test(content)) {
        releaseDate = content
      }
    }

    // 価格: <span itemprop="price">
    const priceText = $('span[itemprop="price"]').attr('content') || $('span[itemprop="price"]').text()
    const price = priceText ? parseInt(priceText.replace(/[^\d]/g, ''), 10) || null : null

    return { title, author, publisher, isbn: item.isbn, releaseDate, price }
  } catch {
    return null
  }
}

// ==============================
// Step 3: openBD API でジャンル・Cコード情報を補完
// ==============================
type OpenBDBook = {
  onix?: {
    DescriptiveDetail?: {
      Subject?: Array<{
        SubjectSchemeIdentifier?: string
        SubjectCode?: string
      }>
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

type OpenBDInfo = {
  cCode: string | null
  genre: string | null
  // openBD の pubdate をフォールバック用に保持
  pubdate: string | null
  title: string | null
  author: string | null
  publisher: string | null
}

async function fetchOpenBDInfo(isbns: string[]): Promise<Map<string, OpenBDInfo>> {
  const result = new Map<string, OpenBDInfo>()
  if (isbns.length === 0) return result

  const batchSize = 100
  for (let i = 0; i < isbns.length; i += batchSize) {
    const batch = isbns.slice(i, i + batchSize)
    try {
      const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${batch.join(',')}`, {
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) continue

      const data: (OpenBDBook | null)[] = await res.json()
      for (const item of data) {
        if (!item?.summary?.isbn) continue
        const isbn = item.summary.isbn

        let cCode: string | null = null
        let genre: string | null = null
        const subjects = item.onix?.DescriptiveDetail?.Subject || []
        for (const subj of subjects) {
          if (subj.SubjectSchemeIdentifier === '78' && subj.SubjectCode) cCode = subj.SubjectCode
          if (subj.SubjectSchemeIdentifier === '79' && subj.SubjectCode) genre = subj.SubjectCode
        }

        let pubdate: string | null = null
        if (item.summary.pubdate && item.summary.pubdate.length === 8) {
          const p = item.summary.pubdate
          pubdate = `${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6, 8)}`
        }

        result.set(isbn, {
          cCode, genre, pubdate,
          title: item.summary.title || null,
          author: item.summary.author || null,
          publisher: item.summary.publisher || null,
        })
      }
    } catch {
      // continue
    }
  }
  return result
}

// ==============================
// メインの処理
// ==============================
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const results = {
    scrapedItems: 0,
    hanmotoResolved: 0,
    openBDResolved: 0,
    filteredOut: 0,
    alreadyExists: 0,
    updatedReleaseDate: 0,
    newlyRegistered: 0,
    errors: [] as string[],
    newBooks: [] as Array<{ title: string; author: string; publisher: string }>,
  }

  try {
    // 1. 版元ドットコムの query.json API で ISBN リストを収集（90日先まで）
    // 30日区間×3バッチ + 本日発売を並列取得（各最大100件）
    const today = new Date()
    const dateRanges = [
      { from: toDateStr(today), to: toDateStr(addDays(today, 30)) },         // 0-30日
      { from: toDateStr(addDays(today, 31)), to: toDateStr(addDays(today, 60)) },  // 31-60日
      { from: toDateStr(addDays(today, 61)), to: toDateStr(addDays(today, 90)) },  // 61-90日
    ]

    const allItems = new Map<string, HanmotoListItem>() // isbn → item (重複排除)

    // query.json API と HTMLスクレイピング(today)を並列実行
    const fetches = [
      ...dateRanges.map(r => fetchHanmotoByDateRange(r.from, r.to, 0, 100)),
      fetchHanmotoList('/bd/shinkan/today'), // 本日発売（フォールバック）
    ]
    const listResults = await Promise.allSettled(fetches)
    const labels = [
      ...dateRanges.map(r => `query ${r.from}~${r.to}`),
      'today HTML',
    ]
    for (let i = 0; i < listResults.length; i++) {
      const r = listResults[i]
      if (r.status === 'fulfilled') {
        r.value.forEach(item => {
          if (!allItems.has(item.isbn)) allItems.set(item.isbn, item)
        })
      } else {
        results.errors.push(`リスト取得エラー (${labels[i]}): ${r.reason}`)
      }
    }
    results.scrapedItems = allItems.size

    if (allItems.size === 0 && results.errors.length > 0) {
      return NextResponse.json(results, { status: 500 })
    }

    // 2. openBD API でジャンル・Cコード・発売日を一括取得（並列実行）
    const allIsbns = Array.from(allItems.keys())
    const [openBDMap, existingBooksResult] = await Promise.all([
      fetchOpenBDInfo(allIsbns),
      supabase.from('books').select('id, isbn, title, author, release_date'),
    ])
    // openBDResolved は実際に登録に使った件数をカウント（下のループで加算）

    // 3. 既存書籍の確認（Step 2で並列取得済み）
    const existingBooks = existingBooksResult.data

    const existingIsbns = new Map<string, { id: string; release_date: string | null }>()
    const existingTitles = new Set<string>()
    for (const b of (existingBooks || [])) {
      if (b.isbn) existingIsbns.set(b.isbn, { id: b.id, release_date: b.release_date })
      existingTitles.add(`${b.title}|${b.author}`)
    }

    // 4. 各書籍を処理
    for (const [isbn, item] of allItems) {
      const elapsed = Date.now() - startTime
      if (elapsed > 8000) {
        results.errors.push('タイムアウト間近のため処理を中断')
        break
      }

      const obInfo = openBDMap.get(isbn)

      // 4a. ジャンルフィルタリング（openBD のCコード/ジャンルで判定）
      const cCode = obInfo?.cCode || null
      const genre = obInfo?.genre || null
      const titleForFilter = obInfo?.title || ''
      if (shouldExclude(titleForFilter, cCode, genre)) {
        results.filteredOut++
        continue
      }

      // 4b. 既存チェック
      const existingByIsbn = existingIsbns.get(isbn)
      if (existingByIsbn) {
        // 既存書籍に release_date が欠損 → openBDのpubdateで補完（高速）
        if (!existingByIsbn.release_date && obInfo?.pubdate) {
          try {
            await supabase.from('books').update({ release_date: obInfo.pubdate }).eq('id', existingByIsbn.id)
            results.updatedReleaseDate++
          } catch {
            // ignore
          }
        }
        results.alreadyExists++
        continue
      }

      // タイトルベースの重複チェック用（openBDの情報を使う）
      const obTitle = obInfo?.title || ''
      const obAuthor = obInfo?.author || ''
      if (obTitle && existingTitles.has(`${obTitle}|${obAuthor}`)) {
        results.alreadyExists++
        continue
      }

      // 4c. 新規書籍の登録
      // openBD にタイトル情報があればそのまま使う（高速）
      // 発売日が未取得でも登録し、fix-dates バッチで後から補完する
      let bookData: BookData
      if (obInfo?.title) {
        // openBD で十分な情報がある → 個別ページ取得をスキップ（高速化）
        bookData = {
          title: obInfo.title,
          author: obInfo.author || '',
          publisher: obInfo.publisher || '',
          isbn,
          releaseDate: obInfo.pubdate,
          cCode,
          genre,
          price: null,
        }
        results.openBDResolved++
      } else {
        // openBD にデータがない → 版元ドットコム個別ページから取得
        const elapsed2 = Date.now() - startTime
        if (elapsed2 > 7000) {
          // 個別ページ取得は重いのでタイムアウト間近なら中断
          results.errors.push('タイムアウト間近のため個別取得を中断')
          break
        }
        try {
          const detail = await fetchHanmotoBookDetail(item)
          if (detail) {
            results.hanmotoResolved++
            bookData = {
              title: detail.title,
              author: detail.author,
              publisher: detail.publisher,
              isbn: detail.isbn,
              releaseDate: detail.releaseDate,
              cCode,
              genre,
              price: detail.price,
            }
          } else {
            continue // 両方失敗 → スキップ
          }
        } catch {
          continue
        }
      }

      // 再度タイトル重複チェック
      if (existingTitles.has(`${bookData.title}|${bookData.author}`)) {
        results.alreadyExists++
        continue
      }

      // 5. 登録
      try {
        const { error } = await supabase.from('books').insert({
          title: bookData.title,
          author: bookData.author,
          publisher: bookData.publisher || null,
          isbn: bookData.isbn,
          price: bookData.price,
          release_date: bookData.releaseDate,
          c_code: bookData.cCode,
          genre: bookData.genre,
          rank: null,
          status: '未対応',
          sns_data: {},
          evaluation_reason: '自動検出 - SNS調査待ち',
          source: '版元ドットコム + openBD',
        })

        if (error) {
          results.errors.push(`登録エラー (${bookData.title}): ${error.message}`)
        } else {
          results.newlyRegistered++
          results.newBooks.push({
            title: bookData.title,
            author: bookData.author,
            publisher: bookData.publisher,
          })
          existingTitles.add(`${bookData.title}|${bookData.author}`)
          if (bookData.isbn) existingIsbns.set(bookData.isbn, { id: '', release_date: bookData.releaseDate })
        }
      } catch (e) {
        results.errors.push(`登録エラー (${bookData.title}): ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // 6. Slack通知
    const slackWebhook = process.env.SLACK_WEBHOOK_URL
    if (slackWebhook && results.newlyRegistered > 0) {
      try {
        const bookList = results.newBooks
          .slice(0, 20)
          .map(b => `・『${b.title}』${b.author}（${b.publisher}）`)
          .join('\n')

        await fetch(slackWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `📚 新刊自動検出（${new Date().toLocaleDateString('ja-JP')}）\n\n`
              + `【新規発見: ${results.newlyRegistered}冊】\n${bookList}\n`
              + (results.newlyRegistered > 20 ? `...他${results.newlyRegistered - 20}冊\n` : '')
              + `\n※ SNS調査・ランク付けは未完了です\n`
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
