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

    // 著者名に最も近いチャンネルを選択（完全一致優先）
    let bestChannel = channels[0]
    for (const ch of channels) {
      const title = ch.snippet?.channelTitle || ''
      if (title === authorName || title.includes(authorName)) {
        bestChannel = ch
        break
      }
    }

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
