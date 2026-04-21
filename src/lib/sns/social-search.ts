/**
 * Google Custom Search API で著者のSNSプロフィールを検索
 *
 * 必要な環境変数:
 *   GOOGLE_SEARCH_API_KEY  - Google Cloud Console で取得
 *   GOOGLE_SEARCH_CX       - Custom Search Engine ID
 *
 * Billing 有効: $5/1,000クエリ（無料枠100/日超過分）
 * 1冊あたり2クエリ（汎用検索で幅広くヒット）
 *
 * ※ API キーが未設定の場合はスキップして空配列を返す
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

/**
 * Google Custom Search で著者のSNSプロフィールを検索
 * site:制限なしの汎用検索2回でヒット率を向上（8クエリ→2クエリ）
 *
 * 返り値:
 *   profiles: プラットフォーム別に整理したプロフィール
 *   rawResults: 全検索結果（Claudeに生データとして渡す用）
 */
export async function searchSocialProfiles(
  authorName: string,
  apiKey: string | undefined,
  cx: string | undefined
): Promise<{ profiles: SocialProfile[]; rawResults: SearchResultRaw[] }> {
  if (!apiKey || !cx) return { profiles: [], rawResults: [] }

  const allItems: Array<{ title: string; link: string; snippet: string }> = []

  // 2回の汎用検索（site:制限なし）
  const queries = [
    `${authorName} YouTube X Twitter Instagram フォロワー`,
    `${authorName} TikTok Facebook podcast Voicy note`,
  ]

  for (let i = 0; i < queries.length; i++) {
    if (i > 0) {
      await new Promise(r => setTimeout(r, 300))
    }

    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(queries[i])}&num=10`
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })

      if (res.status === 429 || res.status === 403) {
        const errorData = await res.json().catch(() => ({}))
        const reason = errorData?.error?.message || `HTTP ${res.status}`
        if (reason.includes('Quota') || reason.includes('quota') || reason.includes('rateLimitExceeded') || res.status === 429) {
          if (reason.includes('rateLimitExceeded') || res.status === 429) {
            await new Promise(r => setTimeout(r, 1000))
            const retryRes = await fetch(url, { signal: AbortSignal.timeout(8000) })
            if (retryRes.ok) {
              const retryData = await retryRes.json()
              const items = retryData.items || []
              allItems.push(...items.map((it: { title?: string; link?: string; snippet?: string }) => ({
                title: it.title || '',
                link: it.link || '',
                snippet: it.snippet || '',
              })))
              continue
            }
          }
          throw new QuotaExhaustedError(`Google Custom Search APIクォータ超過: ${reason}`)
        }
        continue
      }

      if (!res.ok) continue

      const data = await res.json()
      const items = data.items || []
      allItems.push(...items.map((it: { title?: string; link?: string; snippet?: string }) => ({
        title: it.title || '',
        link: it.link || '',
        snippet: it.snippet || '',
      })))
    } catch (e) {
      if (e instanceof QuotaExhaustedError) throw e
      // 検索エラーは無視して続行
    }
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

  // 全検索結果をClaudeに渡す用の生データ
  const rawResults: SearchResultRaw[] = allItems.map(item => ({
    title: item.title,
    url: item.link,
    snippet: (item.snippet || '').slice(0, 300),
  }))

  return { profiles, rawResults }
}

/**
 * テキストからフォロワー数を抽出（"1.2M Followers", "10万フォロワー" 等）
 */
function parseFollowerCount(text: string): number | null {
  if (!text) return null

  // 英語表記: "1.2M Followers", "50K followers"
  const englishMatch = text.match(/([\d.]+)\s*(K|M|B)\s*(?:Followers|followers|フォロワー)/i)
  if (englishMatch) {
    const num = parseFloat(englishMatch[1])
    const unit = englishMatch[2].toUpperCase()
    if (unit === 'K') return Math.round(num * 1000)
    if (unit === 'M') return Math.round(num * 1000000)
    if (unit === 'B') return Math.round(num * 1000000000)
  }

  // 日本語表記: "10万フォロワー", "1.5万人"
  const japaneseMatch = text.match(/([\d.]+)\s*万\s*(?:人|フォロワー|Followers)?/i)
  if (japaneseMatch) {
    return Math.round(parseFloat(japaneseMatch[1]) * 10000)
  }

  // 数値のみ: "フォロワー 12345" "フォロワー数12,345"
  const numMatch = text.match(/フォロワー[数]?\s*:?\s*([\d,]+)/i)
  if (numMatch) {
    return parseInt(numMatch[1].replace(/,/g, ''), 10)
  }

  // 登録者数: "登録者数 10万人", "チャンネル登録者数10.5万"
  const subscriberMatch = text.match(/登録者[数]?\s*:?\s*([\d.]+)\s*万/i)
  if (subscriberMatch) {
    return Math.round(parseFloat(subscriberMatch[1]) * 10000)
  }

  const subscriberNumMatch = text.match(/登録者[数]?\s*:?\s*([\d,]+)\s*人/i)
  if (subscriberNumMatch) {
    return parseInt(subscriberNumMatch[1].replace(/,/g, ''), 10)
  }

  return null
}
