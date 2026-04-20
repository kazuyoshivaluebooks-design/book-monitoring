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
 * ※ API キーが未設定の場合はスキップして空配列を返す
 *
 * 最適化: 8プラットフォーム個別検索 → 2クエリ（SNS + 音声メディア）にOR結合
 *   → 1冊あたり2クエリ → 無料枠で50冊/日処理可能
 */

export type SocialProfile = {
  platform: 'x' | 'instagram' | 'facebook' | 'tiktok' | 'voicy' | 'standfm' | 'podcast' | 'note'
  url: string
  displayName: string | null
  snippet: string | null
  estimatedFollowers: number | null
}

/** クォータ切れを示すエラー */
export class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaExhaustedError'
  }
}

// URL からプラットフォームを判定
function detectPlatform(url: string): SocialProfile['platform'] | null {
  if (url.includes('x.com') || url.includes('twitter.com')) return 'x'
  if (url.includes('instagram.com')) return 'instagram'
  if (url.includes('facebook.com')) return 'facebook'
  if (url.includes('tiktok.com')) return 'tiktok'
  if (url.includes('voicy.jp')) return 'voicy'
  if (url.includes('stand.fm')) return 'standfm'
  if (url.includes('podcasts.apple.com') || url.includes('open.spotify.com/show')) return 'podcast'
  if (url.includes('note.com')) return 'note'
  return null
}

/**
 * Google Custom Search で著者のSNSプロフィールを検索（最適化版）
 *
 * 2クエリで8プラットフォームをカバー:
 *  1) SNS系: x.com, twitter.com, instagram.com, facebook.com, tiktok.com, note.com
 *  2) 音声系: voicy.jp, stand.fm, podcasts.apple.com, open.spotify.com
 */
export async function searchSocialProfiles(
  authorName: string,
  apiKey: string | undefined,
  cx: string | undefined
): Promise<SocialProfile[]> {
  if (!apiKey || !cx) return []

  const profiles: SocialProfile[] = []

  // 2つのバッチクエリ（OR結合）
  const queries = [
    {
      // SNS系: 10件取得（6プラットフォーム分）
      query: `${authorName} site:x.com OR site:twitter.com OR site:instagram.com OR site:facebook.com OR site:tiktok.com OR site:note.com`,
      num: 10,
    },
    {
      // 音声メディア系: 5件取得（3プラットフォーム分）
      query: `${authorName} site:voicy.jp OR site:stand.fm OR site:podcasts.apple.com OR site:open.spotify.com`,
      num: 5,
    },
  ]

  for (const { query, num } of queries) {
    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=${num}`
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })

      if (res.status === 429 || res.status === 403) {
        // クォータ切れ — 呼び出し元に通知
        const errorData = await res.json().catch(() => ({}))
        const reason = errorData?.error?.message || `HTTP ${res.status}`
        if (reason.includes('Quota') || reason.includes('quota') || reason.includes('rateLimitExceeded') || res.status === 429) {
          throw new QuotaExhaustedError(`Google Custom Search APIクォータ超過: ${reason}`)
        }
        // 403 だがクォータ以外の理由の場合はスキップ
        continue
      }

      if (!res.ok) continue

      const data = await res.json()
      const items = data.items || []

      // 各プラットフォームごとに最初の1件のみ採用（重複防止）
      const seenPlatforms = new Set(profiles.map(p => p.platform))

      for (const item of items) {
        const itemUrl = item.link || ''
        const platform = detectPlatform(itemUrl)
        if (!platform || seenPlatforms.has(platform)) continue

        seenPlatforms.add(platform)
        const snippet = item.snippet || ''
        profiles.push({
          platform,
          url: itemUrl,
          displayName: item.title || null,
          snippet: snippet.slice(0, 200),
          estimatedFollowers: parseFollowerCount(snippet),
        })
      }
    } catch (e) {
      // QuotaExhaustedError は再スロー
      if (e instanceof QuotaExhaustedError) throw e
      // その他のエラー（タイムアウト等）は無視して次のクエリへ
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
