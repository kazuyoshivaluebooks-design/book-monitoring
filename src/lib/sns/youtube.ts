/**
 * YouTube Data API v3 で著者のチャンネル情報を取得
 *
 * 必要な環境変数: YOUTUBE_API_KEY
 * 無料枠: 10,000ユニット/日
 * - search.list: 100ユニット
 * - channels.list: 1ユニット
 * - videos.list: 1ユニット
 */

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3'

export type YouTubeChannelData = {
  channelId: string
  channelTitle: string
  channelUrl: string
  subscriberCount: number
  videoCount: number
  viewCount: number
  recentVideos: Array<{
    title: string
    viewCount: number
    likeCount: number
    commentCount: number
    publishedAt: string
  }>
}

/**
 * 著者名でYouTubeチャンネルを検索し、チャンネル情報 + 直近動画のエンゲージメントを取得
 */
export async function searchYouTubeAuthor(
  authorName: string,
  apiKey: string
): Promise<YouTubeChannelData | null> {
  try {
    // 1. 著者名でチャンネルを検索
    const searchUrl = `${YOUTUBE_API_BASE}/search?part=snippet&q=${encodeURIComponent(authorName)}&type=channel&maxResults=3&key=${apiKey}`
    const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) })
    if (!searchRes.ok) return null

    const searchData = await searchRes.json()
    const channels = searchData.items || []
    if (channels.length === 0) return null

    // 著者名に最も近いチャンネルを選択（完全一致 or 部分一致のみ採用）
    // 一致しない場合は別人のチャンネルの可能性が高いためnullを返す
    let bestChannel = null
    for (const ch of channels) {
      const title = (ch.snippet?.channelTitle || '').trim()
      const desc = (ch.snippet?.description || '').trim()
      if (
        title === authorName ||
        title.includes(authorName) ||
        authorName.includes(title) ||
        desc.includes(authorName)
      ) {
        bestChannel = ch
        break
      }
    }

    // 著者名と一致するチャンネルが見つからない場合はスキップ（別人防止）
    if (!bestChannel) return null

    const channelId = bestChannel.snippet?.channelId || bestChannel.id?.channelId
    if (!channelId) return null

    // 2. チャンネルの詳細統計情報を取得
    const channelUrl = `${YOUTUBE_API_BASE}/channels?part=statistics,snippet&id=${channelId}&key=${apiKey}`
    const channelRes = await fetch(channelUrl, { signal: AbortSignal.timeout(5000) })
    if (!channelRes.ok) return null

    const channelData = await channelRes.json()
    const channelInfo = channelData.items?.[0]
    if (!channelInfo) return null

    const stats = channelInfo.statistics || {}
    const subscriberCount = parseInt(stats.subscriberCount || '0', 10)
    const videoCount = parseInt(stats.videoCount || '0', 10)
    const viewCount = parseInt(stats.viewCount || '0', 10)

    // 3. チャンネルの直近動画を取得（最新5件）
    const videosSearchUrl = `${YOUTUBE_API_BASE}/search?part=snippet&channelId=${channelId}&order=date&maxResults=5&type=video&key=${apiKey}`
    const videosSearchRes = await fetch(videosSearchUrl, { signal: AbortSignal.timeout(5000) })

    const recentVideos: YouTubeChannelData['recentVideos'] = []

    if (videosSearchRes.ok) {
      const videosSearchData = await videosSearchRes.json()
      const videoItems = videosSearchData.items || []
      const videoIds = videoItems
        .map((v: { id?: { videoId?: string } }) => v.id?.videoId)
        .filter(Boolean)

      if (videoIds.length > 0) {
        // 動画の統計情報を一括取得
        const videoStatsUrl = `${YOUTUBE_API_BASE}/videos?part=statistics,snippet&id=${videoIds.join(',')}&key=${apiKey}`
        const videoStatsRes = await fetch(videoStatsUrl, { signal: AbortSignal.timeout(5000) })

        if (videoStatsRes.ok) {
          const videoStatsData = await videoStatsRes.json()
          for (const video of videoStatsData.items || []) {
            const vStats = video.statistics || {}
            recentVideos.push({
              title: video.snippet?.title || '',
              viewCount: parseInt(vStats.viewCount || '0', 10),
              likeCount: parseInt(vStats.likeCount || '0', 10),
              commentCount: parseInt(vStats.commentCount || '0', 10),
              publishedAt: video.snippet?.publishedAt || '',
            })
          }
        }
      }
    }

    return {
      channelId,
      channelTitle: channelInfo.snippet?.title || '',
      channelUrl: `https://www.youtube.com/channel/${channelId}`,
      subscriberCount,
      videoCount,
      viewCount,
      recentVideos,
    }
  } catch {
    return null
  }
}

/**
 * 検索結果から見つかったYouTubeチャンネルURL/IDで直接チャンネル情報を取得
 * YouTube Data API の search.list (100ユニット) を使わず channels.list (1ユニット) のみで済む
 */
export async function getYouTubeChannelByUrl(
  url: string,
  apiKey: string
): Promise<YouTubeChannelData | null> {
  try {
    // URLからチャンネルIDまたはハンドルを抽出
    let channelId: string | null = null
    let handle: string | null = null

    const channelMatch = url.match(/youtube\.com\/channel\/([A-Za-z0-9_-]+)/)
    const handleMatch = url.match(/youtube\.com\/@([A-Za-z0-9_.-]+)/)
    const userMatch = url.match(/youtube\.com\/(?:user|c)\/([A-Za-z0-9_.-]+)/)

    if (channelMatch) {
      channelId = channelMatch[1]
    } else if (handleMatch) {
      handle = handleMatch[1]
    } else if (userMatch) {
      handle = userMatch[1]
    } else {
      return null
    }

    // チャンネル情報を取得
    let channelApiUrl: string
    if (channelId) {
      channelApiUrl = `${YOUTUBE_API_BASE}/channels?part=statistics,snippet&id=${channelId}&key=${apiKey}`
    } else {
      // ハンドルで検索（forHandle パラメータ）
      channelApiUrl = `${YOUTUBE_API_BASE}/channels?part=statistics,snippet&forHandle=${handle}&key=${apiKey}`
    }

    const channelRes = await fetch(channelApiUrl, { signal: AbortSignal.timeout(5000) })
    if (!channelRes.ok) return null

    const channelData = await channelRes.json()
    const channelInfo = channelData.items?.[0]
    if (!channelInfo) {
      // forHandle で見つからない場合、search で試す（ユーザー名検索）
      if (handle && !channelId) {
        const searchUrl = `${YOUTUBE_API_BASE}/search?part=snippet&q=${encodeURIComponent(handle)}&type=channel&maxResults=1&key=${apiKey}`
        const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(5000) })
        if (!searchRes.ok) return null
        const searchData = await searchRes.json()
        const found = searchData.items?.[0]
        if (!found) return null
        channelId = found.snippet?.channelId || found.id?.channelId
        if (!channelId) return null
        // 再度 channels.list で取得
        const retryUrl = `${YOUTUBE_API_BASE}/channels?part=statistics,snippet&id=${channelId}&key=${apiKey}`
        const retryRes = await fetch(retryUrl, { signal: AbortSignal.timeout(5000) })
        if (!retryRes.ok) return null
        const retryData = await retryRes.json()
        const retryInfo = retryData.items?.[0]
        if (!retryInfo) return null
        return buildChannelData(retryInfo, apiKey)
      }
      return null
    }

    return buildChannelData(channelInfo, apiKey)
  } catch {
    return null
  }
}

/** チャンネル情報から YouTubeChannelData を構築（直近動画込み） */
async function buildChannelData(
  channelInfo: Record<string, unknown>,
  apiKey: string
): Promise<YouTubeChannelData> {
  const stats = (channelInfo.statistics || {}) as Record<string, string>
  const snippet = (channelInfo.snippet || {}) as Record<string, string>
  const channelId = channelInfo.id as string
  const subscriberCount = parseInt(stats.subscriberCount || '0', 10)
  const videoCount = parseInt(stats.videoCount || '0', 10)
  const viewCount = parseInt(stats.viewCount || '0', 10)

  // 直近動画を取得（5件）
  const recentVideos: YouTubeChannelData['recentVideos'] = []
  try {
    const videosSearchUrl = `${YOUTUBE_API_BASE}/search?part=snippet&channelId=${channelId}&order=date&maxResults=5&type=video&key=${apiKey}`
    const videosSearchRes = await fetch(videosSearchUrl, { signal: AbortSignal.timeout(5000) })
    if (videosSearchRes.ok) {
      const videosSearchData = await videosSearchRes.json()
      const videoIds = (videosSearchData.items || [])
        .map((v: { id?: { videoId?: string } }) => v.id?.videoId)
        .filter(Boolean)
      if (videoIds.length > 0) {
        const videoStatsUrl = `${YOUTUBE_API_BASE}/videos?part=statistics,snippet&id=${videoIds.join(',')}&key=${apiKey}`
        const videoStatsRes = await fetch(videoStatsUrl, { signal: AbortSignal.timeout(5000) })
        if (videoStatsRes.ok) {
          const videoStatsData = await videoStatsRes.json()
          for (const video of videoStatsData.items || []) {
            const vStats = video.statistics || {}
            recentVideos.push({
              title: video.snippet?.title || '',
              viewCount: parseInt(vStats.viewCount || '0', 10),
              likeCount: parseInt(vStats.likeCount || '0', 10),
              commentCount: parseInt(vStats.commentCount || '0', 10),
              publishedAt: video.snippet?.publishedAt || '',
            })
          }
        }
      }
    }
  } catch {
    // 動画取得失敗してもチャンネル情報は返す
  }

  return {
    channelId,
    channelTitle: snippet.title || '',
    channelUrl: `https://www.youtube.com/channel/${channelId}`,
    subscriberCount,
    videoCount,
    viewCount,
    recentVideos,
  }
}
