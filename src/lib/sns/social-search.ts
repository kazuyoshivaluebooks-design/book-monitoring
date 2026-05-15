/**
 * SNS検索API - 著者のSNSプロフィールを検索
 *
 * 対応する検索エンジン（優先順）:
 *   1. Serper.dev (SERPER_API_KEY) ★推奨
 *      - 通常のGoogle検索結果を返すAPI
 *      - 無料枠: 2,500クエリ（クレカ不要）
 *      - 1冊あたり1クエリで十分な結果が得られる
 *
 *   2. Brave Search API (BRAVE_SEARCH_API_KEY)
 *      - $5/1,000クエリ（毎月$5の無料クレジット付き）
 *
 *   3. Google Custom Search API (GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX)
 *      - ※ 要API有効化
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
// ※ 2026年5月時点: 公開インスタンスの大半がJSON APIを無効化（403 Forbidden）
// セルフホスト時は SEARXNG_INSTANCE_URL 環境変数で指定し SEARXNG_ENABLED=true に設定

async function searchWithSearXNG(
  authorName: string
): Promise<Array<{ title: string; link: string; snippet: string }>> {
  const instanceUrl = process.env.SEARXNG_INSTANCE_URL
  if (!instanceUrl) return []

  const query = buildSiteQuery(authorName)

  try {
    const url = `${instanceUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general&language=ja`
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; BookMonitoring/1.0)',
      },
      signal: AbortSignal.timeout(3000),
    })

    if (!res.ok) return []

    const data = await res.json()
    const results = data.results || []
    if (results.length === 0) return []

    return results.slice(0, 20).map((r: { title?: string; url?: string; content?: string }) => ({
      title: r.title || '',
      link: r.url || '',
      snippet: r.content || '',
    }))
  } catch {
    return []
  }
}

// ─────── Serper.dev (Google検索API) ───────

async function searchWithSerper(
  authorName: string,
  apiKey: string
): Promise<Array<{ title: string; link: string; snippet: string }>> {
  const allItems: Array<{ title: string; link: string; snippet: string }> = []

  // 3クエリ戦略（1著者あたり3 Serperクレジット消費）:
  //   Q1: SNSプロフィール直接発見（site:指定 → X, Instagram, note等のプロフィールに直接ヒット）
  //   Q2: YouTube/TikTok/Podcast発見（動画・音声プラットフォーム）
  //   Q3: 補完検索（site:制限なし → インタビュー記事、まとめ記事等からSNS情報を発見）
  const queries = [
    `"${authorName}" (site:x.com OR site:twitter.com OR site:instagram.com OR site:note.com OR site:facebook.com)`,
    `"${authorName}" (site:youtube.com OR site:tiktok.com OR site:voicy.jp OR site:stand.fm OR site:podcasts.apple.com OR site:open.spotify.com)`,
    `"${authorName}" SNS OR Twitter OR YouTube OR Instagram OR フォロワー`,
  ]

  for (let i = 0; i < queries.length; i++) {
    // 2つ目以降のクエリは少し待つ（レート制限対策）
    if (i > 0) await new Promise(r => setTimeout(r, 200))

    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: queries[i],
          gl: 'jp',
          hl: 'ja',
          num: 10,
        }),
        signal: AbortSignal.timeout(5000),
      })

      // クレジット不足・クォータ超過はフォールバック対象
      if (res.status === 429 || res.status === 400 || res.status === 402 || res.status === 403) {
        const text = await res.text().catch(() => '')
        if (text.includes('Not enough credits') || text.includes('quota') || res.status === 429 || res.status === 402) {
          throw new QuotaExhaustedError(`Serper.dev APIクレジット不足 (HTTP ${res.status})`)
        }
      }

      if (!res.ok) {
        console.error(`[serper] HTTP ${res.status}: ${await res.text().catch(() => '')}`)
        continue
      }

      const data = await res.json()
      const organic = data.organic || []

      // 重複URL排除
      const existingUrls = new Set(allItems.map(item => item.link))
      for (const item of organic) {
        const link = item.link || ''
        if (link && !existingUrls.has(link)) {
          allItems.push({
            title: item.title || '',
            link,
            snippet: item.snippet || '',
          })
          existingUrls.add(link)
        }
      }

      // Knowledge Graph情報もあれば活用（著名人の場合に有用）
      if (data.knowledgeGraph) {
        const kg = data.knowledgeGraph
        if (kg.description) {
          const kgLink = kg.website || ''
          const existingUrlsNow = new Set(allItems.map(item => item.link))
          if (!kgLink || !existingUrlsNow.has(kgLink)) {
            allItems.push({
              title: kg.title || authorName,
              link: kgLink,
              snippet: `${kg.description} ${kg.descriptionSource || ''}`.trim(),
            })
          }
        }
      }
    } catch (e) {
      if (e instanceof QuotaExhaustedError) throw e
      console.error(`[serper] error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return allItems
}

// ─────── Brave Search API ───────

async function searchWithBrave(
  authorName: string,
  apiKey: string
): Promise<Array<{ title: string; link: string; snippet: string }>> {
  const allItems: Array<{ title: string; link: string; snippet: string }> = []

  // クエリ戦略:
  //   1. SNSサイト限定検索（著者のSNSプロフィールを直接発見）
  //   2. 一般検索「著者名 SNS」（サイト制限なし → プロフィールリンクを含む記事・インタビュー等を発見）
  // 2つ目のクエリでsite:制限を外すことで、SNS以外のサイトに書かれた
  // フォロワー数やSNSアカウントへの言及も拾える
  const allSites = SNS_SITES.map(s => `site:${s}`).join(' OR ')
  const queries = [
    `"${authorName}" (${allSites})`,
    `"${authorName}" SNS OR Twitter OR YouTube OR Instagram OR フォロワー`,
  ]

  for (let i = 0; i < queries.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 300))

    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(queries[i])}&count=20`
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(4000),
      })

      if (res.status === 429) {
        throw new QuotaExhaustedError('Brave Search APIクォータ超過')
      }

      if (res.status === 401 || res.status === 403) {
        return allItems  // 1クエリ目の結果があればそれを返す
      }

      if (!res.ok) continue

      const data = await res.json()
      const results = (data.web?.results || []).map((r: { title?: string; url?: string; description?: string }) => ({
        title: r.title || '', link: r.url || '', snippet: r.description || '',
      }))

      // 重複URL排除
      const existingUrls = new Set(allItems.map(item => item.link))
      for (const item of results) {
        if (!existingUrls.has(item.link)) {
          allItems.push(item)
          existingUrls.add(item.link)
        }
      }
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
 * 優先順: Serper.dev → Brave → Google CSE
 */
export async function searchSocialProfiles(
  authorName: string,
  apiKey: string | undefined,
  cx: string | undefined
): Promise<{ profiles: SocialProfile[]; rawResults: SearchResultRaw[] }> {
  let allItems: Array<{ title: string; link: string; snippet: string }> = []

  const serperApiKey = process.env.SERPER_API_KEY
  const braveApiKey = process.env.BRAVE_SEARCH_API_KEY

  // 優先順に試行し、結果が空ならフォールバック
  // 1. Serper.dev（Google検索API） ★推奨
  if (serperApiKey) {
    try {
      allItems = await searchWithSerper(authorName, serperApiKey)
    } catch {
      // Serperクォータ切れ・エラー時はフォールバック
    }
  }

  // 2. Brave Search API
  if (allItems.length === 0 && braveApiKey) {
    try {
      allItems = await searchWithBrave(authorName, braveApiKey)
    } catch {
      // Braveクォータ切れ・エラー時はフォールバック
    }
  }

  // 3. Google CSE（最終フォールバック）
  if (allItems.length === 0 && apiKey && cx) {
    allItems = await searchWithGoogle(authorName, apiKey, cx)
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
 * 検索結果からYouTubeチャンネルURLを抽出
 * YouTube Data API の著者名検索で見つからなかった場合のフォールバック用
 */
export function extractYouTubeUrls(
  rawResults: Array<{ title: string; url: string; snippet: string }>
): string[] {
  const urls: string[] = []
  const seen = new Set<string>()

  for (const item of rawResults) {
    const lower = item.url.toLowerCase()
    // チャンネルページ or ハンドルページのみ（個別動画ページは除外）
    if (
      (lower.includes('youtube.com/channel/') ||
       lower.includes('youtube.com/@') ||
       lower.includes('youtube.com/user/') ||
       lower.includes('youtube.com/c/')) &&
      !lower.includes('/watch') &&
      !lower.includes('/shorts')
    ) {
      // 正規化して重複排除
      const normalized = item.url.split('?')[0].replace(/\/$/, '')
      if (!seen.has(normalized)) {
        seen.add(normalized)
        urls.push(item.url)
      }
    }
  }

  return urls
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
