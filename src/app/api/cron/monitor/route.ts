/**
 * 新刊モニタリング cron
 *
 * Biblon API (JPRO + 日販データ) から120日先までの新刊を取得し、
 * Supabase に登録する。ジャンルフィルタ・重複チェック付き。
 *
 * GET /api/cron/monitor?token={CRON_SECRET}
 * Vercel cron: 毎日 23:00 (Sun-Fri)
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { fetchUpcomingBooks, type BiblonBook } from '@/lib/biblon'

export const dynamic = 'force-dynamic'
export const maxDuration = 10 // Vercel Hobby: 10s

// 除外ジャンルのキーワード
const EXCLUDED_KEYWORDS = [
  'コミック', '漫画', 'まんが', 'マンガ', 'ライトノベル',
  '写真集', 'グラビア', '児童書', '雑誌', 'ムック',
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

/** 日付を YYYY-MM-DD に変換 */
function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0]
}

/** 日数を加算 */
function addDays(d: Date, days: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + days)
  return r
}

/** Biblon の publishedDate フィールドから release_date を取得 */
function extractReleaseDate(book: BiblonBook): string | null {
  // publishedDate: YYYY-MM-DD 形式の正確な出版日
  if (book.publishedDate) {
    return book.publishedDate
  }
  // フォールバック: year のみの場合
  if (book.year) {
    return `${book.year}-01-01`
  }
  return null
}

// ==============================
// メインの処理
// ==============================
export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get('mode')
  const isDryRun = mode === 'dry-run'
  const isManualRun = mode === 'run-now'

  // dry-run / run-now 以外は認証必須
  if (!isDryRun && !isManualRun) {
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret) {
      const token = request.nextUrl.searchParams.get('token')
      const authHeader = request.headers.get('authorization')
      if (token !== cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
    }
  }

  const startTime = Date.now()
  const results = {
    biblonFetched: 0,
    filteredOut: 0,
    alreadyExists: 0,
    newlyRegistered: 0,
    errors: [] as string[],
    newBooks: [] as Array<{ title: string; author: string; publisher: string }>,
  }

  const biblonApiKey = process.env.BIBLON_API_KEY
  if (!biblonApiKey) {
    return NextResponse.json({ error: 'BIBLON_API_KEY未設定' }, { status: 500 })
  }

  try {
    // 1 & 2. Biblon取得と既存ISBN取得を並列実行（10s制限対策）
    const today = new Date()
    const publishedFrom = toDateStr(today)
    const publishedTo = toDateStr(addDays(today, 120))

    // 既存ISBN取得関数
    async function loadExistingIsbns(): Promise<Set<string>> {
      const isbns = new Set<string>()
      const PAGE = 1000
      let from = 0
      let hasMore = true
      while (hasMore) {
        if (Date.now() - startTime > 7000) {
          results.errors.push(`既存チェック打ち切り: ${isbns.size}件取得済み`)
          break
        }
        const { data: page, error: pageError } = await supabase
          .from('books')
          .select('isbn')
          .not('isbn', 'is', null)
          .range(from, from + PAGE - 1)
        if (pageError || !page || page.length === 0) {
          hasMore = false
        } else {
          for (const b of page) {
            if (b.isbn) isbns.add(b.isbn)
          }
          from += page.length
          hasMore = page.length === PAGE
        }
      }
      return isbns
    }

    // 並列実行
    const [biblonResult, existingIsbns] = await Promise.all([
      fetchUpcomingBooks(publishedFrom, publishedTo, biblonApiKey, {
        maxPages: 50,
        timeoutMs: 5000,
      }).catch((e: Error) => {
        results.errors.push(`Biblon API エラー: ${e.message}`)
        return [] as BiblonBook[]
      }),
      loadExistingIsbns(),
    ])

    const biblonBooks = biblonResult
    results.biblonFetched = biblonBooks.length

    if (biblonBooks.length === 0) {
      return NextResponse.json({ ...results, message: 'Biblon: 新刊データなし' })
    }

    // 3. フィルタリング＋重複排除＋バッチ挿入リスト構築
    const batchInserts: Array<{
      title: string; author: string; publisher: string | null;
      isbn: string | null; price: number | null; release_date: string | null;
      c_code: string | null; genre: string | null;
      rank: null; status: string; sns_data: Record<string, never>;
      evaluation_reason: string; source: string;
    }> = []

    const seenIsbns = new Set<string>()

    for (const book of biblonBooks) {
      // ISBN必須
      if (!book.isbn || book.isbn.length < 10) continue

      // Biblon内の重複排除
      if (seenIsbns.has(book.isbn)) continue
      seenIsbns.add(book.isbn)

      // 既存チェック
      if (existingIsbns.has(book.isbn)) {
        results.alreadyExists++
        continue
      }

      // ジャンルフィルタリング
      if (shouldExclude(book.title, book.cCode || null, null)) {
        results.filteredOut++
        continue
      }

      batchInserts.push({
        title: book.title,
        author: book.author || '',
        publisher: book.publisher || null,
        isbn: book.isbn,
        price: book.price,
        release_date: extractReleaseDate(book),
        c_code: book.cCode || null,
        genre: null,
        rank: null,
        status: '未対応',
        sns_data: {},
        evaluation_reason: '自動検出 - SNS調査待ち',
        source: `biblon (${book.source})`,
      })

      existingIsbns.add(book.isbn)
    }

    // dry-run: DB書き込みせず結果だけ返す
    if (isDryRun) {
      const elapsed = Date.now() - startTime
      return NextResponse.json({
        mode: 'dry-run',
        ...results,
        wouldInsert: batchInserts.length,
        sampleBooks: batchInserts.slice(0, 10).map(b => ({
          title: b.title, author: b.author, publisher: b.publisher,
          isbn: b.isbn, release_date: b.release_date, source: b.source,
        })),
        elapsedMs: elapsed,
        timestamp: new Date().toISOString(),
      })
    }

    // 4. Supabase にバッチ挿入
    if (batchInserts.length > 0) {
      // Supabaseの制限を考慮して50件ずつバッチ挿入
      const BATCH = 50
      for (let i = 0; i < batchInserts.length; i += BATCH) {
        if (Date.now() - startTime > 8000) {
          results.errors.push(`タイムアウト: ${batchInserts.length - i}件未処理`)
          break
        }

        const batch = batchInserts.slice(i, i + BATCH)
        try {
          const { error } = await supabase.from('books').insert(batch)
          if (error) {
            // バッチ失敗時は1件ずつリトライ
            for (const row of batch) {
              const { error: retryErr } = await supabase.from('books').insert(row)
              if (!retryErr) {
                results.newlyRegistered++
                results.newBooks.push({ title: row.title, author: row.author, publisher: row.publisher || '' })
              }
            }
          } else {
            results.newlyRegistered += batch.length
            for (const row of batch) {
              results.newBooks.push({ title: row.title, author: row.author, publisher: row.publisher || '' })
            }
          }
        } catch (e) {
          results.errors.push(`バッチ登録エラー: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }

    // 5. Slack通知
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
