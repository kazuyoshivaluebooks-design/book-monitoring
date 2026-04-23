/**
 * SNS検索API - 著者のSNSプロフィールを検索
 *
 * 対応する検索エンジン（優先順）:
 *   1. Brave Search API (BRAVE_SEARCH_API_KEY)
 *      - $5/1,000クエリ（毎月$5の無料クレジット付き）
 *      - site: オペレーターでSNSサイトに制限
 *
 *   2. SearXNG 公開インスタンス（APIキー不要・無料）
 *      - 複数のインスタンスにフォールバック
 *      - site: オペレーターでSNSサイトに制限
 *      - SEARXNG_ENABLED=true で有効化
 *
 *   3. Google Custom Search API (GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX)
 *      - ※ 2025年以降新規顧客への提供終了
 *
 * ※ すべて未設定の場合はスキップして空配列を返す
 */

export type SocialProfile = {
  platform: 'x' | 'instagram' | 'facebook' | 'tiktok' | 'voicy' | 'standfm' | 'podcast' | 'note'
  url: string
  displayName: string | null
  snippet: string | null
  estimatedFollowers: number | null
}

/** 検索結果の生データ（Claudeに渡す用） */
export type SearchResultRaw = {
  title: string
  url: string
  snippet: string
}

/** クォータ切れを示すエラー */
export class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaExhaustedError'
  }
}

/** URLからプラットフォームを判別 */
function detectPlatform(url: string): SocialProfile['platform'] | null {
  const lower = url.toLowerCase()
  if (lower.includes('x.com/') || lower.includes('twitter.com/')) return 'x'
  if (lower.includes('instagram.com/')) return 'instagram'
  if (lower.includes('facebook.com/')) return 'facebook'
  if (lower.includes('tiktok.com/')) return 'tiktok'
  if (lower.includes('voicy.jp/')) return 'voicy'
  if (lower.includes('stand.fm/')) return 'standfm'
  if (lower.includes('podcasts.apple.com/') || lower.includes('open.spotify.com/show')) return 'podcast'
  if (lower.includes('note.com/')) return 'note'
  return null
}

/** SNSサイトのリスト */
const SNS_SITES = [
  'x.com', 'twitter.com', 'instagram.com', 'facebook.com',
  'tiktok.com', 'youtube.com', 'voicy.jp', 'stand.fm',
  'podcasts.apple.com', 'open.spotify.com', 'note.com',
]

/** site: オペレーターを生成 */
function buildSiteQuery(authorName: string): string {
  const siteOr = SNS_SITES.map(s => `site:${s}`).join(' OR ')
  return `"${authorName}" (${siteOr})`
}

// ─────── SearXNG (APIキー不要・無料) ───────

const SEARXNG_INSTANCES = [
  'https://search.ononoki.org',
  'https://searx.tiekoetter.com',
  'https://searx.be',
  'https://search.sapti.me',
  'https://searx.nixnet.services',
  'https://searx.work',
  'https://search.bus-hit.me',
  'https://searx.zhenyapav.com',
  'https://search.mdosch.de',
  'https://searx.juancord.xyz',
]

async function searchWithSearXNG(
  authorName: string
): Promise<Array<{ title: string; link: string; snippet: string }>> {
  const query = buildSiteQuery(authorName)

  for (const instance of SEARXNG_INSTANCES) {
    try {
      const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&categories=general&language=ja`
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; BookMonitoring/1.0)',
        },
        signal: AbortSignal.timeout(10000),
      })

      if (!res.ok) continue

      const data = await res.json()
      const results = data.results || []

      return results.slice(0, 20).map((r: { title?: string; url?: string; content?: string }) => ({
        title: r.title || '',
        link: r.url || '',
        snippet: r.content || '',
      }))
    } catch {
      // このインスタンスが失敗したら次を試す
      continue
    }
  }

  // 全インスタンス失敗
  return []
}

// ─────── Brave Search API ───────

async function searchWithBrave(
  authorName: string,
  apiKey: string
): Promise<Array<{ title: string; link: string; snippet: string }>> {
  const allItems: Array<{ title: string; link: string; snippet: string }> = []

  const siteGroup1 = ['x.com', 'twitter.com', 'instagram.com', 'youtube.com', 'tiktok.com', 'note.com']
  const siteGroup2 = ['facebook.com', 'voicy.jp', 'stand.fm', 'podcasts.apple.com', 'open.spotify.com']

  const queries = [
    `"${authorName}" ${siteGroup1.map(s => `site:${s}`).join(' OR ')}`,
    `"${authorName}" ${siteGroup2.map(s => `site:${s}`).join(' OR ')}`,
  ]

  for (let i = 0; i < queries.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 500))

    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(queries[i])}&count=20`
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(10000),
      })

      if (res.status === 429) {
        const waitMs = 2000
        await new Promise(r => setTimeout(r, waitMs))
        const retryRes = await fetch(url, {
          headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey },
          signal: AbortSignal.timeout(10000),
        })
        if (retryRes.ok) {
          const data = await retryRes.json()
          allItems.push(...(data.web?.results || []).map((r: { title?: string; url?: string; description?: string }) => ({
            title: r.title || '', link: r.url || '', snippet: r.description || '',
          })))
          continue
        }
        if (i === 0) throw new QuotaExhaustedError(`Brave Search APIレート制限`)
        continue
      }

      if (!res.ok) continue

      const data = await res.json()
      allItems.push(...(data.web?.results || []).map((r: { title?: string; url?: string; description?: string }) => ({
        title: r.title || '', link: r.url || '', snippet: r.description || '',
      })))
    } catch (e) {
      if (e instanceof QuotaExhaustedError) throw e
    }
  }

  return allItems
}

// ─────── Google Custom Search API ───────

async function searchWithGoogle(
  authorName: string,
  apiKey: string,
  cx: string
): Promise<Array<{ title: string; link: string; snippet: string }>> {
  const allItems: Array<{ title: string; link: string; snippet: string }> = []

  const queries = [`"${authorName}"`, `${authorName} 公式`]

  for (let i = 0; i < queries.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 300))

    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(queries[i])}&num=10`
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })

      if (res.status === 429 || res.status === 403) {
        const errorData = await res.json().catch(() => ({}))
        const reason = errorData?.error?.message || `HTTP ${res.status}`
        if (reason.includes('Quota') || reason.includes('quota') || reason.includes('rateLimitExceeded') || res.status === 429) {
          throw new QuotaExhaustedError(`Google CSE クォータ超過: ${reason}`)
        }
        continue
      }

      if (!res.ok) continue

      const data = await res.json()
      allItems.push(...(data.items || []).map((it: { title?: string; link?: string; snippet?: string }) => ({
        title: it.title || '', link: it.link || '', snippet: it.snippet || '',
      })))
    } catch (e) {
      if (e instanceof QuotaExhaustedError) throw e
    }
  }

  return allItems
}

// ─────── メイン関数 ───────

/**
 * 著者のSNSプロフィールを検索
 * 優先順: Brave → SearXNG → Google CSE
 */
export async function searchSocialProfiles(
  authorName: string,
  apiKey: string | undefined,
  cx: string | undefined
): Promise<{ profiles: SocialProfile[]; rawResults: SearchResultRaw[] }> {
  let allItems: Array<{ title: string; link: string; snippet: string }> = []

  const braveApiKey = process.env.BRAVE_SEARCH_API_KEY
  const searxngEnabled = process.env.SEARXNG_ENABLED === 'true'

  if (braveApiKey) {
    allItems = await searchWithBrave(authorName, braveApiKey)
  } else if (searxngEnabled) {
    allItems = await searchWithSearXNG(authorName)
  } else if (apiKey && cx) {
    allItems = await searchWithGoogle(authorName, apiKey, cx)
  } else {
    return { profiles: [], rawResults: [] }
  }

  // 検索結果からプラットフォーム別プロフィールを抽出
  const profiles: SocialProfile[] = []
  const seenPlatforms = new Set<string>()

  for (const item of allItems) {
    const platform = detectPlatform(item.link)
    if (platform && !seenPlatforms.has(platform)) {
      seenPlatforms.add(platform)
      profiles.push({
        platform,
        url: item.link,
        displayName: item.title || null,
        snippet: (item.snippet || '').slice(0, 200),
        estimatedFollowers: parseFollowerCount(item.snippet || ''),
      })
    }
  }

  const rawResults: SearchResultRaw[] = allItems.map(item => ({
    title: item.title,
    url: item.link,
    snippet: (item.snippet || '').slice(0, 300),
  }))

  return { profiles, rawResults }
}

/**
 * テキストからフォロワー数を抽出
 */
function parseFollowerCount(text: string): number | null {
  if (!text) return null

  const englishMatch = text.match(/([\d.]+)\s*(K|M|B)\s*(?:Followers|followers|フォロワー)/i)
  if (englishMatch) {
    const num = parseFloat(englishMatch[1])
    const unit = englishMatch[2].toUpperCase()
    if (unit === 'K') return Math.round(num * 1000)
    if (unit === 'M') return Math.round(num * 1000000)
    if (unit === 'B') return Math.round(num * 1000000000)
  }

  const japaneseMatch = text.match(/([\d.]+)\s*万\s*(?:人|フォロワー|Followers)?/i)
  if (japaneseMatch) return Math.round(parseFloat(japaneseMatch[1]) * 10000)

  const numMatch = text.match(/フォロワー[数]?\s*:?\s*([\d,]+)/i)
  if (numMatch) return parseInt(numMatch[1].replace(/,/g, ''), 10)

  const subscriberMatch = text.match(/登録者[数]?\s*:?\s*([\d.]+)\s*万/i)
  if (subscriberMatch) return Math.round(parseFloat(subscriberMatch[1]) * 10000)

  const subscriberNumMatch = text.match(/登録者[数]?\s*:?\s*([\d,]+)\s*人/i)
  if (subscriberNumMatch) return parseInt(subscriberNumMatch[1].replace(/,/g, ''), 10)

  return null
}
