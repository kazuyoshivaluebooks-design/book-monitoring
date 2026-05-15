/**
 * Claude API で SNS データを基に著者の影響力と書籍の販売見込みを総合判定
 *
 * B案: Claudeが検索結果からSNSアカウントの特定・本人確認・ランク判定を一括処理
 * YouTubeデータはAPI取得済みのものを渡し、それ以外はClaudeが検索結果から判断
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
  description: string | null
}

/**
 * 収集した SNS データから Claude API でランク判定
 * B案: Claudeがアカウント特定 + ランク判定を一括処理
 */
export async function rankBook(
  book: BookInfo,
  youtube: YouTubeChannelData | null,
  socialProfiles: SocialProfile[],
  rawSearchResults: SearchResultRaw[],
  apiKey: string
): Promise<RankResult> {
  const client = new Anthropic({ apiKey })

  // YouTube データセクション（API取得済みの正確なデータ）
  const youtubeSection = youtube
    ? `
## YouTube データ（API取得済み・正確な数値）
- チャンネル名: ${youtube.channelTitle}
- 登録者数: ${youtube.subscriberCount.toLocaleString()}人
- 総再生回数: ${youtube.viewCount.toLocaleString()}回
- 動画本数: ${youtube.videoCount}本
- 直近動画のエンゲージメント:
${youtube.recentVideos.map(v =>
  `  - 「${v.title}」再生${v.viewCount.toLocaleString()} / いいね${v.likeCount.toLocaleString()} / コメント${v.commentCount.toLocaleString()}`
).join('\n')}`
    : '## YouTube: データなし'

  // 検索で機械的に見つかったSNSプロフィール（参考情報としてClaudeに提示）
  const detectedProfiles = socialProfiles.filter(p =>
    ['x', 'instagram', 'facebook', 'tiktok', 'note', 'voicy', 'standfm', 'podcast'].includes(p.platform)
  )

  const profilesSection = detectedProfiles.length > 0
    ? `
## 検索で検出されたSNS URL（参考・要検証）
以下は検索結果のURLから機械的に抽出したものです。著者本人のアカウントかどうかを検証してください。
${detectedProfiles.map(p => {
  const followers = p.estimatedFollowers
    ? `推定フォロワー${p.estimatedFollowers.toLocaleString()}人`
    : 'フォロワー数不明'
  return `- ${p.platform.toUpperCase()}: ${p.url}\n  ${followers}\n  ${p.snippet || ''}`
}).join('\n')}`
    : '## SNS URL: 機械的な検出なし'

  // Web検索の生データ（Claudeが読み取って判断する主要ソース）
  const rawResultsSection = rawSearchResults.length > 0
    ? `
## Web検索の生データ（著者名 + SNSプラットフォーム名で検索した結果）
以下の検索結果から、著者本人のSNSアカウント、フォロワー数、影響力に関する情報を読み取ってください。
${rawSearchResults.slice(0, 15).map((r, i) =>
  `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`
).join('\n')}`
    : '## Web検索: 結果なし'

  const prompt = `あなたは中古書店の仕入れ担当です。以下の新刊書籍について、著者のSNS影響力を分析し、販売見込みランクを判定してください。

## 書籍情報
- タイトル: ${book.title}
- 著者: ${book.author}
- 出版社: ${book.publisher || '不明'}
- ISBN: ${book.isbn || '不明'}
- 価格: ${book.price ? `${book.price}円` : '不明'}
- 発売日: ${book.releaseDate || '不明'}
${book.description ? `- 内容紹介: ${book.description.slice(0, 300)}` : ''}

${youtubeSection}

${profilesSection}

${rawResultsSection}

## あなたのタスク

### 1. SNSアカウントの特定と本人確認
検索結果とURL一覧から、著者**本人**のSNSアカウントを特定してください。
- 同姓同名の別人のアカウントは絶対に含めないでください
- 本人かどうかは、アカウント名・プロフィール内容・活動分野から判断してください
- 本人と確信が持てないアカウントは含めないでください
- 検索結果のスニペットからフォロワー数・登録者数を読み取ってください
- YouTubeデータがAPI取得済みの場合、そのデータをそのまま採用してください

**重要: フォロワー数の誤読に注意**
- 「累計○万部」「シリーズ○万部」は**書籍の売上部数**であり、フォロワー数ではありません
- 「○万人」という数字がフォロワー数なのか、書籍売上なのか、会員数なのかを慎重に区別してください
- 検索スニペットに明確に「フォロワー」「登録者」と書かれている数字のみをフォロワー数として採用してください
- 不明な場合は0としてください（過大評価より過小評価の方が安全です）

### 2. ランク判定

【高確率】以下のいずれかに該当:
- SNS合計フォロワー10万人以上
- YouTube登録者5万人以上かつエンゲージメント率が高い
- ポッドキャスト（Voicy/Spotify/Apple等）で人気番組を持つ著者
- テレビ出演など、SNS外でも著名な著者
- 検索結果から著者が有名人・インフルエンサーであることが読み取れる場合

【中確率】以下のいずれかに該当:
- SNS合計フォロワー1万〜10万人
- YouTube登録者1万〜5万人
- 特定分野で影響力があるが、一般的な知名度は限定的

【注目】以下のいずれかに該当:
- SNS合計フォロワー3,000〜1万人
- 最近急成長中のアカウント
- 話題性の高いテーマ
- フォロワー数は少ないがエンゲージメント率が非常に高い

【null（判定不可）】:
- SNSプロフィールが見つからない
- フォロワー数が判別できない
- 判定に十分な情報がない

## よくある判定ミスの例（必ず避けてください）

❌ 誤: 「累計100万部のベストセラー作家」→ SNSフォロワー100万人と誤認 → 高確率
✅ 正: 書籍売上とSNSフォロワーは別物。SNSアカウントが見つからなければnull

❌ 誤: 検索結果に「Twitter」「YouTube」という単語があるだけでSNSアクティブと判断
✅ 正: 実際のアカウントURLとフォロワー数が確認できなければカウントしない

❌ 誤: 同姓同名の別人（例: 一般的な名前の著者）のSNSアカウントを誤帰属
✅ 正: プロフィール内容・活動分野が書籍のジャンルと一致するか確認

❌ 誤: 出版社やメディアのアカウントを著者本人のアカウントとして計上
✅ 正: 出版社・書店・メディアのアカウントは除外

❌ 誤: フォロワー数の根拠を示さずに「影響力がある」と判定
✅ 正: 必ず具体的な数値（フォロワーXX人、登録者XX人）を根拠に含める

## 出力フォーマット（JSON で回答）
{
  "rank": "高確率" | "中確率" | "注目" | null,
  "reason": "判定理由を200文字以内で記述。必ず具体的なフォロワー数・登録者数の根拠を含める。数値が確認できない場合はその旨を明記",
  "confidence": "high" | "medium" | "low",
  "snsAccounts": {
    "x": { "url": "https://x.com/...", "followers": 12345 },
    "instagram": { "url": "https://instagram.com/...", "followers": 51000 },
    "youtube": { "url": "https://youtube.com/@...", "subscribers": 80000 },
    "tiktok": { "url": "https://tiktok.com/@...", "followers": 0 },
    "facebook": { "url": "https://facebook.com/...", "followers": 0 },
    "voicy": { "url": "https://voicy.jp/...", "followers": 0 },
    "standfm": { "url": "https://stand.fm/...", "followers": 0 },
    "podcast": { "url": "https://open.spotify.com/show/...", "followers": 0 },
    "note": { "url": "https://note.com/...", "followers": 0 }
  }
}

snsAccountsには著者本人と確認できたアカウントのみ含めてください。
該当プラットフォームがなければそのキーは省略してください。
フォロワー数が不明な場合は0としてください。
YouTubeについて: API取得済みデータがある場合はそのデータが優先されます。検索結果からYouTubeチャンネルを発見した場合はsnsAccountsのyoutubeキーにURL・登録者数を含めてください（API取得済みデータで上書きされる場合があります）。

JSONのみで回答してください。マークダウンのコードブロックは不要です。`

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.content[0]?.type === 'text'
      ? response.content[0].text
      : ''

    // JSON パース（Claude がマークダウンコードブロックで囲む場合に対応）
    const cleaned = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    const result = JSON.parse(cleaned)
    const validRanks = ['高確率', '中確率', '注目', null]
    let rank = validRanks.includes(result.rank) ? result.rank : null

    // confidence: "low" の場合、高確率・中確率は信頼できないのでダウングレード
    if (result.confidence === 'low' && (rank === '高確率' || rank === '中確率')) {
      rank = '注目'  // 低確信度の高ランクは「注目」に下げる
    }

    // Claudeが特定したSNSアカウントからsnsDataを構築
    const snsData: SnsData = {}

    // YouTube: API取得済みデータを最優先、なければClaudeの検出結果を使用
    if (youtube) {
      snsData.youtube = {
        subscribers: youtube.subscriberCount,
        url: youtube.channelUrl,
      }
    } else if (result.snsAccounts?.youtube?.url) {
      // ClaudeがWeb検索結果からYouTubeチャンネルを発見した場合（APIデータなし）
      snsData.youtube = {
        subscribers: result.snsAccounts.youtube.subscribers || result.snsAccounts.youtube.followers || 0,
        url: result.snsAccounts.youtube.url,
      }
    }

    // Claude が特定した各プラットフォームのアカウント
    const accounts = result.snsAccounts || {}
    const platformKeys = ['x', 'instagram', 'facebook', 'tiktok', 'voicy', 'standfm', 'podcast', 'note'] as const

    for (const key of platformKeys) {
      const account = accounts[key]
      if (account && account.url) {
        if (key === 'podcast') {
          snsData[key] = {
            followers: account.followers || 0,
            url: account.url,
            platform: account.url.includes('spotify') ? 'Spotify' : 'Apple Podcasts',
          }
        } else {
          snsData[key] = {
            followers: account.followers || 0,
            url: account.url,
          }
        }
      }
    }

    return {
      rank,
      snsData,
      evaluationReason: result.reason || '判定理由なし',
    }
  } catch (e) {
    // Claude API エラー時はフォールバック（ルールベース判定）
    const errorMsg = e instanceof Error ? e.message : String(e)
    console.error(`[ranker] Claude API error for "${book.title}": ${errorMsg}`)

    // フォールバック用に機械的抽出のsnsDataを構築
    const fallbackSnsData = buildFallbackSnsData(youtube, socialProfiles)
    const fallback = fallbackRanking(fallbackSnsData, book)
    fallback.evaluationReason = `${fallback.evaluationReason} [Claude APIエラー: ${errorMsg.slice(0, 100)}]`
    return fallback
  }
}

/** フォールバック用: 機械的抽出からsnsDataを構築 */
function buildFallbackSnsData(youtube: YouTubeChannelData | null, socialProfiles: SocialProfile[]): SnsData {
  const snsData: SnsData = {}

  if (youtube) {
    snsData.youtube = { subscribers: youtube.subscriberCount, url: youtube.channelUrl }
  }

  for (const p of socialProfiles) {
    if (p.platform === 'x') snsData.x = { followers: p.estimatedFollowers || 0, url: p.url }
    else if (p.platform === 'instagram') snsData.instagram = { followers: p.estimatedFollowers || 0, url: p.url }
    else if (p.platform === 'facebook') snsData.facebook = { followers: p.estimatedFollowers || 0, url: p.url }
    else if (p.platform === 'tiktok') snsData.tiktok = { followers: p.estimatedFollowers || 0, url: p.url }
    else if (p.platform === 'voicy') snsData.voicy = { followers: p.estimatedFollowers || 0, url: p.url }
    else if (p.platform === 'standfm') snsData.standfm = { followers: p.estimatedFollowers || 0, url: p.url }
    else if (p.platform === 'podcast') snsData.podcast = { followers: p.estimatedFollowers || 0, url: p.url, platform: p.url?.includes('spotify') ? 'Spotify' : 'Apple Podcasts' }
    else if (p.platform === 'note') snsData.note = { followers: p.estimatedFollowers || 0, url: p.url }
  }

  return snsData
}

/**
 * Claude API がエラーの場合のフォールバック（ルールベース判定）
 */
function fallbackRanking(snsData: SnsData, book: BookInfo): RankResult {
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
