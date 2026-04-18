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

async function fetchOpenBDBatch(batch: string[]): Promise<Map<string, OpenBDInfo>> {
  const result = new Map<string, OpenBDInfo>()
  if (batch.length === 0) return result
  try {
    const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${batch.join(',')}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return result

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
  return result
}

// 複数バッチを並列実行
async function fetchOpenBDInfo(isbns: string[]): Promise<Map<string, OpenBDInfo>> {
  const result = new Map<string, OpenBDInfo>()
  if (isbns.length === 0) return result

  const batchSize = 100
  const batches: string[][] = []
  for (let i = 0; i < isbns.length; i += batchSize) {
    batches.push(isbns.slice(i, i + batchSize))
  }

  const results = await Promise.allSettled(batches.map(b => fetchOpenBDBatch(b)))
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const [k, v] of r.value) result.set(k, v)
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

    // query.json API + 既存書籍リストを並列取得（Supabaseは高速なので先に取る）
    const fetches = [
      ...dateRanges.map(r => fetchHanmotoByDateRange(r.from, r.to, 0, 100)),
      fetchHanmotoList('/bd/shinkan/today'), // 本日発売（フォールバック）
    ]
    const [listResults, existingBooksResult] = await Promise.all([
      Promise.allSettled(fetches),
      supabase.from('books').select('id, isbn, title, author, release_date'),
    ])

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

    // 2. 既存書籍のISBN/タイトルセットを構築
    const existingBooks = existingBooksResult.data
    const existingIsbns = new Map<string, { id: string; release_date: string | null }>()
    const existingTitles = new Set<string>()
    for (const b of (existingBooks || [])) {
      if (b.isbn) existingIsbns.set(b.isbn, { id: b.id, release_date: b.release_date })
      existingTitles.add(`${b.title}|${b.author}`)
    }

    // 3. 未登録ISBNのみ抽出してopenBDを取得（大幅に高速化）
    const unknownIsbns = Array.from(allItems.keys()).filter(isbn => !existingIsbns.has(isbn))
    const openBDMap = await fetchOpenBDInfo(unknownIsbns)
    // openBDResolved は実際に登録に使った件数をカウント（下のループで加算）

    // 4. Phase 1: openBDデータがある書籍を一括収集（高速、ネットワーク不要）
    const batchInserts: Array<{
      title: string; author: string; publisher: string | null;
      isbn: string | null; price: number | null; release_date: string | null;
      c_code: string | null; genre: string | null;
      rank: null; status: string; sns_data: Record<string, never>;
      evaluation_reason: string; source: string;
    }> = []
    const noOpenBDItems: Array<[string, HanmotoListItem]> = []

    for (const [isbn, item] of allItems) {
      // 既存チェック
      if (existingIsbns.has(isbn)) {
        results.alreadyExists++
        continue
      }

      const obInfo = openBDMap.get(isbn)
      const cCode = obInfo?.cCode || null
      const genre = obInfo?.genre || null
      const titleForFilter = obInfo?.title || ''

      // ジャンルフィルタリング
      if (shouldExclude(titleForFilter, cCode, genre)) {
        results.filteredOut++
        continue
      }

      // タイトル重複チェック
      const obTitle = obInfo?.title || ''
      const obAuthor = obInfo?.author || ''
      if (obTitle && existingTitles.has(`${obTitle}|${obAuthor}`)) {
        results.alreadyExists++
        continue
      }

      if (obInfo?.title) {
        // openBDデータあり → バッチ挿入リストに追加
        batchInserts.push({
          title: obInfo.title,
          author: obInfo.author || '',
          publisher: obInfo.publisher || null,
          isbn,
          price: null,
          release_date: obInfo.pubdate,
          c_code: cCode,
          genre,
          rank: null,
          status: '未対応',
          sns_data: {},
          evaluation_reason: '自動検出 - SNS調査待ち',
          source: '版元ドットコム + openBD',
        })
        existingTitles.add(`${obInfo.title}|${obInfo.author || ''}`)
        existingIsbns.set(isbn, { id: '', release_date: obInfo.pubdate })
        results.openBDResolved++
      } else {
        noOpenBDItems.push([isbn, item])
      }
    }

    // 5. Phase 1 バッチ挿入（1回のAPI呼び出しで全件登録）
    if (batchInserts.length > 0) {
      try {
        const { error, data } = await supabase.from('books').insert(batchInserts).select('title, author')
        if (error) {
          results.errors.push(`バッチ登録エラー: ${error.message}`)
          // バッチ失敗時は1件ずつリトライ
          for (const row of batchInserts) {
            const { error: retryErr } = await supabase.from('books').insert(row)
            if (!retryErr) {
              results.newlyRegistered++
              results.newBooks.push({ title: row.title, author: row.author, publisher: row.publisher || '' })
            }
            if (Date.now() - startTime > 8000) break
          }
        } else {
          results.newlyRegistered += batchInserts.length
          for (const row of batchInserts) {
            results.newBooks.push({ title: row.title, author: row.author, publisher: row.publisher || '' })
          }
        }
      } catch (e) {
        results.errors.push(`バッチ登録例外: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // 6. Phase 2: openBDにないISBNは版元ドットコム個別ページから取得（残り時間で）
    for (const [isbn, item] of noOpenBDItems) {
      const elapsed = Date.now() - startTime
      if (elapsed > 7500) {
        results.errors.push(`残り${noOpenBDItems.length}件は次回処理`)
        break
      }

      try {
        const detail = await fetchHanmotoBookDetail(item)
        if (!detail) continue

        if (existingTitles.has(`${detail.title}|${detail.author}`)) {
          results.alreadyExists++
          continue
        }

        const { error } = await supabase.from('books').insert({
          title: detail.title,
          author: detail.author,
          publisher: detail.publisher || null,
          isbn: detail.isbn,
          price: detail.price,
          release_date: detail.releaseDate,
          c_code: null,
          genre: null,
          rank: null,
          status: '未対応',
          sns_data: {},
          evaluation_reason: '自動検出 - SNS調査待ち',
          source: '版元ドットコム',
        })

        if (!error) {
          results.hanmotoResolved++
          results.newlyRegistered++
          results.newBooks.push({ title: detail.title, author: detail.author, publisher: detail.publisher })
          existingTitles.add(`${detail.title}|${detail.author}`)
          existingIsbns.set(isbn, { id: '', release_date: detail.releaseDate })
        }
      } catch {
        continue
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
