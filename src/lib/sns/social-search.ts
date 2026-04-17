/**
 * Google Custom Search API で著者のSNSプロフィールを検索
 *
 * 必要な環境変数:
 *   GOOGLE_SEARCH_API_KEY  - Google Cloud Console で取得
 *   GOOGLE_SEARCH_CX       - Custom Search Engine ID
 *
 * 無料枠: 100クエリ/日
 * 有料: $5/1,000クエリ
 *
 * ※ API キーが未設定の場合はスキップして null を返す
 */

export type SocialProfile = {
  platform: 'x' | 'instagram' | 'facebook'
  url: string
  displayName: string | null
  snippet: string | null
  estimatedFollowers: number | null
}

/**
 * Google Custom Search で著者のSNSプロフィールを検索
 */
export async function searchSocialProfiles(
  authorName: string,
  apiKey: string | undefined,
  cx: string | undefined
): Promise<SocialProfile[]> {
  if (!apiKey || !cx) return []

  const profiles: SocialProfile[] = []

  // 各プラットフォームで検索
  const platforms: Array<{
    platform: SocialProfile['platform']
    site: string
    label: string
  }> = [
    { platform: 'x', site: 'x.com OR site:twitter.com', label: 'X/Twitter' },
    { platform: 'instagram', site: 'instagram.com', label: 'Instagram' },
    { platform: 'facebook', site: 'facebook.com', label: 'Facebook' },
  ]

  for (const { platform, site } of platforms) {
    try {
      const query = `${authorName} site:${site}`
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=3`
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })

      if (!res.ok) continue

      const data = await res.json()
      const items = data.items || []

      if (items.length > 0) {
        const item = items[0]
        const profileUrl = item.link || ''
        const snippet = item.snippet || ''
        const displayName = item.title || null

        // スニペットからフォロワー数を推定（"1.2M Followers" のような表記）
        const estimatedFollowers = parseFollowerCount(snippet)

        profiles.push({
          platform,
          url: profileUrl,
          displayName,
          snippet: snippet.slice(0, 200),
          estimatedFollowers,
        })
      }
    } catch {
      // 個別プラットフォームのエラーは無視
    }
  }

  return profiles
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

  return null
}
