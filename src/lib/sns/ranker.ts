/**
 * Claude API で SNS データを基に著者の影響力と書籍の販売見込みを総合判定
 *
 * 必要な環境変数: ANTHROPIC_API_KEY
 * 推定コスト: 1冊あたり約$0.001〜0.003
 */

import Anthropic from '@anthropic-ai/sdk'
import type { YouTubeChannelData } from './youtube'
import type { SocialProfile, SearchResultRaw } from './social-search'
import type { SnsData } from '@/lib/supabase'

export type RankResult = {
  rank: '高確率' | '中確率' | '注目' | null
  snsData: SnsData
  evaluationReason: string
}

type BookInfo = {
  title: string
  author: string
  publisher: string | null
  isbn: string | null
  price: number | null
  releaseDate: string | null
}

/**
 * 収集した SNS データから Claude API でランク判定
 */
export async function rankBook(
  book: BookInfo,
  youtube: YouTubeChannelData | null,
  socialProfiles: SocialProfile[],
  rawSearchResults: SearchResultRaw[],
  apiKey: string
): Promise<RankResult> {
  const client = new Anthropic({ apiKey })

  // SNS データを構造化
  const snsData: SnsData = {}

  // YouTube
  if (youtube) {
    snsData.youtube = {
      subscribers: youtube.subscriberCount,
      url: youtube.channelUrl,
    }
  }

  // X/Twitter
  const xProfile = socialProfiles.find(p => p.platform === 'x')
  if (xProfile) {
    snsData.x = {
      followers: xProfile.estimatedFollowers || 0,
      url: xProfile.url,
    }
  }

  // Instagram
  const igProfile = socialProfiles.find(p => p.platform === 'instagram')
  if (igProfile) {
    snsData.instagram = {
      followers: igProfile.estimatedFollowers || 0,
      url: igProfile.url,
    }
  }

  // Facebook
  const fbProfile = socialProfiles.find(p => p.platform === 'facebook')
  if (fbProfile) {
    snsData.facebook = {
      followers: fbProfile.estimatedFollowers || 0,
      url: fbProfile.url,
    }
  }

  // TikTok
  const tiktokProfile = socialProfiles.find(p => p.platform === 'tiktok')
  if (tiktokProfile) {
    snsData.tiktok = {
      followers: tiktokProfile.estimatedFollowers || 0,
      url: tiktokProfile.url,
    }
  }

  // Voicy
  const voicyProfile = socialProfiles.find(p => p.platform === 'voicy')
  if (voicyProfile) {
    snsData.voicy = {
      followers: voicyProfile.estimatedFollowers || 0,
      url: voicyProfile.url,
    }
  }

  // stand.fm
  const standfmProfile = socialProfiles.find(p => p.platform === 'standfm')
  if (standfmProfile) {
    snsData.standfm = {
      followers: standfmProfile.estimatedFollowers || 0,
      url: standfmProfile.url,
    }
  }

  // Podcast (Apple/Spotify)
  const podcastProfile = socialProfiles.find(p => p.platform === 'podcast')
  if (podcastProfile) {
    snsData.podcast = {
      followers: podcastProfile.estimatedFollowers || 0,
      url: podcastProfile.url,
      platform: podcastProfile.url?.includes('spotify') ? 'Spotify' : 'Apple Podcasts',
    }
  }

  // note
  const noteProfile = socialProfiles.find(p => p.platform === 'note')
  if (noteProfile) {
    snsData.note = {
      followers: noteProfile.estimatedFollowers || 0,
      url: noteProfile.url,
    }
  }

  // Claude API で判定
  const youtubeSection = youtube
    ? `
## YouTube データ
- チャンネル名: ${youtube.channelTitle}
- 登録者数: ${youtube.subscriberCount.toLocaleString()}人
- 総再生回数: ${youtube.viewCount.toLocaleString()}回
- 動画本数: ${youtube.videoCount}本
- 直近動画のエンゲージメント:
${youtube.recentVideos.map(v =>
  `  - 「${v.title}」再生${v.viewCount.toLocaleString()} / いいね${v.likeCount.toLocaleString()} / コメント${v.commentCount.toLocaleString()}`
).join('\n')}`
    : '## YouTube: チャンネル未発見（YouTube Data APIで該当なし）'

  // 検索で見つかったSNSプロフィール
  const detectedProfiles = socialProfiles.filter(p =>
    ['x', 'instagram', 'facebook', 'tiktok', 'note', 'voicy', 'standfm', 'podcast'].includes(p.platform)
  )

  const profilesSection = detectedProfiles.length > 0
    ? `
## 検索で見つかったSNSプロフィール
${detectedProfiles.map(p => {
  const followers = p.estimatedFollowers
    ? `推定フォロワー${p.estimatedFollowers.toLocaleString()}人`
    : 'フォロワー数不明'
  return `- ${p.platform.toUpperCase()}: ${p.url}\n  ${followers}\n  ${p.snippet || ''}`
}).join('\n')}`
    : '## SNSプロフィール: URLの直接検出なし'

  // Google検索の生データ（Claudeが追加情報を読み取る）
  const rawResultsSection = rawSearchResults.length > 0
    ? `
## Google検索の生データ（著者名 + SNSプラットフォーム名で検索した結果）
以下の検索結果から、著者のSNSアカウント、フォロワー数、影響力に関する情報を読み取ってください。
${rawSearchResults.slice(0, 15).map((r, i) =>
  `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`
).join('\n')}`
    : '## Google検索: 結果なし'

  const prompt = `あなたは中古書店の仕入れ担当です。以下の新刊書籍について、著者のSNS影響力とエンゲージメントを分析し、販売見込みランクを判定してください。

## 書籍情報
- タイトル: ${book.title}
- 著者: ${book.author}
- 出版社: ${book.publisher || '不明'}
- ISBN: ${book.isbn || '不明'}
- 価格: ${book.price ? `${book.price}円` : '不明'}
- 発売日: ${book.releaseDate || '不明'}

${youtubeSection}

${profilesSection}

${rawResultsSection}

## 判定基準

【高確率】以下のいずれかに該当:
- SNS合計フォロワー10万人以上
- YouTube登録者5万人以上かつエンゲージメント率が高い
- 各プラットフォームのフォロワー合算が大きく、著書の販促に積極的と判断できる
- ポッドキャスト（Voicy/Spotify/Apple等）で人気番組を持つ著者
- テレビ出演など、SNS外でも著名な著者
- 検索結果から著者が有名人・インフルエンサーであることが読み取れる場合

【中確率】以下のいずれかに該当:
- SNS合計フォロワー1万〜10万人
- YouTube登録者1万〜5万人
- ポッドキャスト配信者で一定のリスナー基盤がある
- 特定分野で影響力があるが、一般的な知名度は限定的
- エンゲージメント率は高いが、規模は中程度

【注目】以下のいずれかに該当:
- SNS合計フォロワー3,000〜1万人
- ポッドキャストや音声メディアで活動が確認できる
- 最近急成長中のアカウント
- 話題性の高いテーマ（トレンド・ニュースに関連）
- フォロワー数は少ないがエンゲージメント率が非常に高い

【null（判定不可）】:
- SNSプロフィールが見つからない
- フォロワー数が判別できない
- 判定に十分な情報がない

## 重要
- Google検索の生データから、フォロワー数・登録者数・リスナー数などの数値情報を積極的に読み取ってください
- 検索結果のスニペットに含まれるSNSアカウントのURLや数値も判断材料にしてください
- 著者名から著名人と判断できる場合は、あなたの知識も活用してください

## 出力フォーマット（JSON で回答）
{
  "rank": "高確率" | "中確率" | "注目" | null,
  "reason": "判定理由を100文字以内で簡潔に記述",
  "confidence": "high" | "medium" | "low"
}

JSONのみで回答してください。マークダウンのコードブロックは不要です。`

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.content[0]?.type === 'text'
      ? response.content[0].text
      : ''

    // JSON パース（Claude がマークダウンコードブロックで囲む場合に対応）
    const cleaned = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    const result = JSON.parse(cleaned)
    const validRanks = ['高確率', '中確率', '注目', null]
    const rank = validRanks.includes(result.rank) ? result.rank : null

    return {
      rank,
      snsData,
      evaluationReason: result.reason || '判定理由なし',
    }
  } catch (e) {
    // Claude API エラー時はフォールバック（ルールベース判定）
    const errorMsg = e instanceof Error ? e.message : String(e)
    console.error(`[ranker] Claude API error for "${book.title}": ${errorMsg}`)
    const fallback = fallbackRanking(snsData, book)
    fallback.evaluationReason = `${fallback.evaluationReason} [Claude APIエラー: ${errorMsg.slice(0, 100)}]`
    return fallback
  }
}

/**
 * Claude API がエラーの場合のフォールバック（ルールベース判定）
 */
function fallbackRanking(snsData: SnsData, book: BookInfo): RankResult {
  // 全プラットフォームのフォロワー合計
  let totalFollowers = 0
  if (snsData.youtube?.subscribers) totalFollowers += snsData.youtube.subscribers
  if (snsData.x?.followers) totalFollowers += snsData.x.followers
  if (snsData.instagram?.followers) totalFollowers += snsData.instagram.followers
  if (snsData.facebook?.followers) totalFollowers += snsData.facebook.followers
  if (snsData.tiktok?.followers) totalFollowers += snsData.tiktok.followers
  if (snsData.voicy?.followers) totalFollowers += snsData.voicy.followers
  if (snsData.standfm?.followers) totalFollowers += snsData.standfm.followers
  if (snsData.podcast?.followers) totalFollowers += snsData.podcast.followers
  if (snsData.note?.followers) totalFollowers += snsData.note.followers

  let rank: RankResult['rank'] = null
  let reason = ''

  if (totalFollowers >= 100000) {
    rank = '高確率'
    reason = `SNS合計フォロワー${totalFollowers.toLocaleString()}人（ルールベース判定）`
  } else if (totalFollowers >= 10000) {
    rank = '中確率'
    reason = `SNS合計フォロワー${totalFollowers.toLocaleString()}人（ルールベース判定）`
  } else if (totalFollowers >= 3000) {
    rank = '注目'
    reason = `SNS合計フォロワー${totalFollowers.toLocaleString()}人（ルールベース判定）`
  } else if (totalFollowers > 0) {
    rank = null
    reason = `SNS合計フォロワー${totalFollowers.toLocaleString()}人 - 影響力限定的（ルールベース判定）`
  } else {
    rank = null
    reason = 'SNSプロフィール未発見または情報不足（ルールベース判定）'
  }

  return { rank, snsData, evaluationReason: reason }
}
