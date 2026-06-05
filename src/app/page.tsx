'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Book, SnsData } from '@/lib/supabase'

const RANK_COLORS: Record<string, string> = {
  '高確率': 'bg-red-100 text-red-800 border-red-300',
  '中確率': 'bg-orange-100 text-orange-800 border-orange-300',
  '注目': 'bg-blue-100 text-blue-800 border-blue-300',
}

const STATUS_COLORS: Record<string, string> = {
  '未対応': 'bg-gray-100 text-gray-700',
  '仕入検討中': 'bg-yellow-100 text-yellow-800',
  '仕入済': 'bg-green-100 text-green-800',
  '見送り': 'bg-slate-100 text-slate-500',
}

const STATUS_OPTIONS = ['未対応', '仕入検討中', '仕入済', '見送り'] as const

// ランクの優先度（数値が小さいほど上位）
const RANK_PRIORITY: Record<string, number> = {
  '高確率': 1,
  '中確率': 2,
  '注目': 3,
}
const RANK_NONE = 99

type SortKey = 'discovered_at' | 'release_date' | 'title' | 'rank'
type SortDir = 'asc' | 'desc'

function compareByField(a: Book, b: Book, field: SortKey, order: SortDir): number {
  let cmp = 0
  if (field === 'rank') {
    const aVal = RANK_PRIORITY[a.rank || ''] ?? RANK_NONE
    const bVal = RANK_PRIORITY[b.rank || ''] ?? RANK_NONE
    cmp = aVal - bVal
  } else if (field === 'release_date' || field === 'discovered_at') {
    const aVal = a[field] || ''
    const bVal = b[field] || ''
    cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0
  } else {
    cmp = (a.title || '').localeCompare(b.title || '', 'ja')
  }
  return order === 'desc' ? -cmp : cmp
}

function formatFollowers(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}千`
  return String(n)
}

function SnsInfo({ snsData }: { snsData: SnsData }) {
  const platforms: { key: keyof SnsData; label: string; field: string }[] = [
    { key: 'x', label: 'X', field: 'followers' },
    { key: 'instagram', label: 'Instagram', field: 'followers' },
    { key: 'youtube', label: 'YouTube', field: 'subscribers' },
    { key: 'tiktok', label: 'TikTok', field: 'followers' },
    { key: 'facebook', label: 'Facebook', field: 'followers' },
    { key: 'voicy', label: 'Voicy', field: 'followers' },
    { key: 'standfm', label: 'stand.fm', field: 'followers' },
    { key: 'podcast', label: 'Podcast', field: 'followers' },
    { key: 'note', label: 'note', field: 'followers' },
  ]

  const getCount = (val: unknown, field: string): number => {
    if (!val || typeof val === 'string') return 0
    const obj = val as Record<string, unknown>
    return (Number(obj[field]) || Number(obj['followers']) || 0)
  }

  const getUrl = (val: unknown): string | null => {
    if (!val || typeof val === 'string') return null
    const obj = val as Record<string, unknown>
    return (obj['url'] as string) || null
  }

  const entries = platforms.filter(p => getCount(snsData[p.key], p.field) > 0 || getUrl(snsData[p.key]) !== null)

  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(p => {
        const count = getCount(snsData[p.key], p.field)
        const url = getUrl(snsData[p.key])
        const hasFollowers = count > 0
        const badge = (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${
            hasFollowers ? 'bg-indigo-50 text-indigo-700' : 'bg-gray-50 text-gray-500'
          } ${url ? 'hover:bg-indigo-100 cursor-pointer' : ''}`}>
            {p.label}{hasFollowers ? `: ${formatFollowers(count)}` : ''}
            {url && <span className="text-indigo-400">↗</span>}
          </span>
        )
        if (url) {
          return (
            <a key={p.key} href={url} target="_blank" rel="noopener noreferrer">
              {badge}
            </a>
          )
        }
        return <span key={p.key}>{badge}</span>
      })}
      {snsData.other && (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-purple-50 text-purple-700">
          {snsData.other}
        </span>
      )}
      {entries.length === 0 && !snsData.other && (
        <span className="text-xs text-gray-400">SNS情報なし</span>
      )}
    </div>
  )
}

function BookCover({ isbn, coverUrl }: { isbn: string | null; coverUrl: string | null }) {
  const [status, setStatus] = useState<'loading' | 'ok' | 'none'>('loading')
  const [imgSrc, setImgSrc] = useState<string | null>(null)

  useEffect(() => {
    // Biblon cover_url を優先、なければ openBD にフォールバック
    const src = coverUrl || (isbn ? `https://cover.openbd.jp/${isbn}.jpg` : null)
    if (!src) { setStatus('none'); return }

    let cancelled = false
    let settled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      settled = true
      if (img.naturalWidth < 10) {
        // Biblon画像が小さい場合、openBDをフォールバック
        if (coverUrl && isbn) {
          settled = false
          const fallback = `https://cover.openbd.jp/${isbn}.jpg`
          const img2 = new Image()
          img2.onload = () => { if (!cancelled) { settled = true; setImgSrc(fallback); setStatus('ok') } }
          img2.onerror = () => { if (!cancelled) { settled = true; setStatus('none') } }
          img2.src = fallback
        } else {
          setStatus('none')
        }
      } else {
        setImgSrc(src)
        setStatus('ok')
      }
    }
    img.onerror = () => {
      if (cancelled) return
      // coverUrl失敗時、openBDフォールバック
      if (coverUrl && isbn) {
        const fallback = `https://cover.openbd.jp/${isbn}.jpg`
        const img2 = new Image()
        img2.onload = () => { if (!cancelled) { settled = true; setImgSrc(fallback); setStatus(img2.naturalWidth < 10 ? 'none' : 'ok') } }
        img2.onerror = () => { if (!cancelled) { settled = true; setStatus('none') } }
        img2.src = fallback
      } else {
        settled = true
        setStatus('none')
      }
    }
    img.src = src
    const timer = setTimeout(() => { if (!cancelled && !settled) setStatus('none') }, 5000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [isbn, coverUrl])

  if (status === 'none') {
    return (
      <div className="w-16 h-22 flex-shrink-0 rounded bg-gray-100 flex items-center justify-center">
        <span className="text-gray-300 text-2xl">📖</span>
      </div>
    )
  }
  if (status === 'loading') {
    return <div className="w-16 h-22 flex-shrink-0 rounded bg-gray-50 animate-pulse" />
  }
  return (
    <img
      src={imgSrc || ''}
      alt=""
      className="w-16 h-auto max-h-24 flex-shrink-0 rounded shadow-sm object-cover"
    />
  )
}

function BookCard({
  book,
  onStatusChange,
  onDelete,
}: {
  book: Book
  onStatusChange: (id: string, status: string) => void
  onDelete: (id: string) => void
}) {
  const [showDetail, setShowDetail] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const isReleased = book.release_date && new Date(book.release_date) <= new Date()

  return (
    <div className={`border rounded-lg p-4 bg-white shadow-sm hover:shadow-md transition-shadow ${
      book.status === '見送り' ? 'opacity-60' : ''
    }`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          {book.rank && (
            <span className={`px-2 py-0.5 rounded border text-xs font-bold ${RANK_COLORS[book.rank]}`}>
              {book.rank}
            </span>
          )}
          {isReleased && (
            <span className="px-2 py-0.5 rounded text-xs bg-emerald-50 text-emerald-600 border border-emerald-200">
              発売済
            </span>
          )}
        </div>
        <select
          value={book.status}
          onChange={(e) => onStatusChange(book.id, e.target.value)}
          className={`text-xs px-2 py-1 rounded-md border cursor-pointer ${STATUS_COLORS[book.status]}`}
        >
          {STATUS_OPTIONS.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <div className="flex gap-3">
        <BookCover isbn={book.isbn} coverUrl={book.cover_url} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-1 mb-1">
            {book.isbn ? (
              <a
                href={`https://www.hanmoto.com/bd/isbn/${book.isbn}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-bold text-base hover:text-indigo-600 hover:underline"
              >
                {book.title}
              </a>
            ) : (
              <span className="font-bold text-base">{book.title}</span>
            )}
            <button
              onClick={() => setShowDetail(!showDetail)}
              className="flex-shrink-0 mt-0.5 text-gray-400 hover:text-indigo-500 text-xs"
              title="詳細を表示"
            >
              {showDetail ? '▲' : '▼'}
            </button>
          </div>
          <p className="text-sm text-gray-600 mb-1">
            {book.author}
            {book.publisher && <span className="text-gray-400"> / {book.publisher}</span>}
          </p>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {book.release_date && (
              <span className="inline-block text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">
                📅 {book.release_date.replace(/-/g, '/')}
              </span>
            )}
            <span className="inline-block text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-500">
              {new Date(book.discovered_at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}検出
            </span>
            {book.pages && (
              <span className="inline-block text-xs px-2 py-0.5 rounded bg-gray-50 text-gray-500">
                {book.pages}p
              </span>
            )}
          </div>
        </div>
      </div>

      <SnsInfo snsData={book.sns_data || {}} />

      {book.evaluation_reason && (
        <div
          className={`mt-2 bg-amber-50 rounded p-2 text-xs text-amber-800 cursor-pointer ${showDetail ? '' : 'line-clamp-3'}`}
          onClick={() => setShowDetail(!showDetail)}
          title={showDetail ? 'クリックで折りたたむ' : 'クリックで全文表示'}
        >
          <span className="font-bold">判定根拠:</span> {book.evaluation_reason}
          {!showDetail && <span className="text-amber-500 ml-1">…▼</span>}
        </div>
      )}

      {showDetail && (
        <div className="mt-3 pt-3 border-t border-gray-100 space-y-2 text-sm">
          <div className="grid grid-cols-2 gap-2 text-gray-600">
            {book.release_date && (
              <div><span className="text-gray-400">発売日:</span> {book.release_date}</div>
            )}
            {book.price && (
              <div><span className="text-gray-400">価格:</span> {book.price.toLocaleString()}円</div>
            )}
            {book.isbn && (
              <div><span className="text-gray-400">ISBN:</span> {book.isbn}</div>
            )}
            {book.genre && (
              <div><span className="text-gray-400">ジャンル:</span> {book.genre}</div>
            )}
            {book.pages && (
              <div><span className="text-gray-400">ページ数:</span> {book.pages}p</div>
            )}
            {book.source && (
              <div><span className="text-gray-400">ソース:</span> {book.source}</div>
            )}
            <div>
              <span className="text-gray-400">発見日:</span>{' '}
              {new Date(book.discovered_at).toLocaleDateString('ja-JP')}
            </div>
          </div>
          {book.description && (
            <div className="mt-2 p-2 bg-gray-50 rounded text-xs text-gray-700 leading-relaxed">
              <span className="font-bold text-gray-500">内容紹介:</span> {book.description.length > 200 ? book.description.slice(0, 200) + '…' : book.description}
            </div>
          )}
          <div className="flex justify-end pt-1">
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-xs text-red-400 hover:text-red-600"
              >
                削除
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-600">本当に削除しますか？</span>
                <button
                  onClick={() => onDelete(book.id)}
                  className="text-xs px-2 py-0.5 bg-red-500 text-white rounded hover:bg-red-600"
                >
                  削除する
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="text-xs px-2 py-0.5 bg-gray-200 rounded hover:bg-gray-300"
                >
                  キャンセル
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ========================================
// 日別ビュー用コンポーネント
// ========================================
function DailyView({
  books,
  onStatusChange,
  onDelete,
}: {
  books: Book[]
  onStatusChange: (id: string, status: string) => void
  onDelete: (id: string) => void
}) {
  // JST基準で日付グループ化
  const grouped = (() => {
    const map = new Map<string, Book[]>()
    for (const book of books) {
      const utc = new Date(book.discovered_at)
      const jst = new Date(utc.getTime() + 9 * 60 * 60 * 1000)
      const dateKey = jst.toISOString().split('T')[0]
      if (!map.has(dateKey)) map.set(dateKey, [])
      map.get(dateKey)!.push(book)
    }
    // 各グループ内をランク順にソート
    for (const [, group] of map) {
      group.sort((a, b) => {
        const aRank = RANK_PRIORITY[a.rank || ''] ?? RANK_NONE
        const bRank = RANK_PRIORITY[b.rank || ''] ?? RANK_NONE
        if (aRank !== bRank) return aRank - bRank
        return (a.title || '').localeCompare(b.title || '', 'ja')
      })
    }
    // 日付降順でソート
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  })()

  const [expandedDates, setExpandedDates] = useState<Set<string>>(() => {
    // 最新2日分を初期展開
    return new Set(grouped.slice(0, 2).map(([d]) => d))
  })

  const toggleDate = (date: string) => {
    setExpandedDates(prev => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }

  const todayJst = (() => {
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000)
    return now.toISOString().split('T')[0]
  })()

  return (
    <div className="space-y-4">
      {grouped.map(([date, dayBooks]) => {
        const isExpanded = expandedDates.has(date)
        const isToday = date === todayJst
        const ranked = dayBooks.filter(b => b.rank)
        const unranked = dayBooks.filter(b => !b.rank)
        const rankSummary = ['高確率', '中確率', '注目']
          .map(r => {
            const count = dayBooks.filter(b => b.rank === r).length
            return count > 0 ? `${r}${count}` : ''
          })
          .filter(Boolean)
          .join(' / ')

        return (
          <div key={date} className="bg-white rounded-lg border shadow-sm overflow-hidden">
            <button
              onClick={() => toggleDate(date)}
              className={`w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-50 transition-colors ${
                isToday ? 'bg-green-50 border-l-4 border-l-green-500' : ''
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="text-lg font-bold text-gray-800">
                  {date.replace(/-/g, '/')}
                </span>
                {isToday && (
                  <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs font-medium">
                    今日
                  </span>
                )}
                <span className="text-sm text-gray-500">
                  {dayBooks.length}冊
                </span>
                {rankSummary && (
                  <span className="text-xs text-gray-400">
                    ({rankSummary})
                  </span>
                )}
              </div>
              <span className="text-gray-400 text-sm">{isExpanded ? '▲' : '▼'}</span>
            </button>

            {isExpanded && (
              <div className="border-t">
                {/* ランク付き書籍 */}
                {ranked.length > 0 && (
                  <div className="divide-y divide-gray-50">
                    {ranked.map(book => (
                      <DailyBookRow key={book.id} book={book} onStatusChange={onStatusChange} onDelete={onDelete} />
                    ))}
                  </div>
                )}
                {/* ランクなし書籍 */}
                {unranked.length > 0 && (
                  <>
                    <div className="px-4 py-1.5 bg-gray-50 text-xs text-gray-400 font-medium">
                      ランクなし ({unranked.length}冊)
                    </div>
                    <div className="divide-y divide-gray-50">
                      {unranked.map(book => (
                        <DailyBookRow key={book.id} book={book} onStatusChange={onStatusChange} onDelete={onDelete} compact />
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
      {grouped.length === 0 && (
        <div className="text-center py-12 text-gray-400">データがありません</div>
      )}
    </div>
  )
}

function DailyBookRow({
  book,
  onStatusChange,
  onDelete,
  compact,
}: {
  book: Book
  onStatusChange: (id: string, status: string) => void
  onDelete: (id: string) => void
  compact?: boolean
}) {
  const [showDetail, setShowDetail] = useState(false)

  return (
    <div className={`px-4 py-2 hover:bg-gray-50 transition-colors ${compact ? 'py-1.5' : ''}`}>
      <div className="flex items-center gap-2">
        {book.rank && (
          <span className={`px-1.5 py-0.5 rounded text-xs font-bold flex-shrink-0 ${RANK_COLORS[book.rank]}`}>
            {book.rank}
          </span>
        )}
        <div className="flex-1 min-w-0 flex items-center gap-2">
          {book.isbn ? (
            <a
              href={`https://www.hanmoto.com/bd/isbn/${book.isbn}`}
              target="_blank"
              rel="noopener noreferrer"
              className={`font-medium hover:text-indigo-600 hover:underline truncate ${compact ? 'text-sm text-gray-600' : 'text-sm'}`}
            >
              {book.title}
            </a>
          ) : (
            <span className={`font-medium truncate ${compact ? 'text-sm text-gray-600' : 'text-sm'}`}>
              {book.title}
            </span>
          )}
          <span className="text-xs text-gray-400 flex-shrink-0 truncate max-w-[150px]">
            {book.author}
          </span>
          {book.publisher && (
            <span className="text-xs text-gray-300 flex-shrink-0 truncate max-w-[120px] hidden md:inline">
              {book.publisher}
            </span>
          )}
        </div>
        {book.release_date && (
          <span className="text-xs text-gray-400 flex-shrink-0 hidden sm:inline">
            {book.release_date.slice(5).replace('-', '/')}
          </span>
        )}
        <select
          value={book.status}
          onChange={(e) => onStatusChange(book.id, e.target.value)}
          className={`text-xs px-1.5 py-0.5 rounded border cursor-pointer flex-shrink-0 ${STATUS_COLORS[book.status]}`}
        >
          {STATUS_OPTIONS.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button
          onClick={() => setShowDetail(!showDetail)}
          className="text-gray-300 hover:text-indigo-500 text-xs flex-shrink-0"
        >
          {showDetail ? '▲' : '▼'}
        </button>
      </div>

      {showDetail && (
        <div className="mt-2 ml-4 space-y-2">
          <div className="flex gap-3">
            <BookCover isbn={book.isbn} coverUrl={book.cover_url} />
            <div className="flex-1 min-w-0">
              <SnsInfo snsData={book.sns_data || {}} />
              {book.evaluation_reason && (
                <p className="mt-1 text-xs text-amber-800 bg-amber-50 rounded p-2">
                  <span className="font-bold">判定根拠:</span> {book.evaluation_reason}
                </p>
              )}
              {book.description && (
                <p className="mt-1 text-xs text-gray-600 bg-gray-50 rounded p-2">
                  {book.description.length > 200 ? book.description.slice(0, 200) + '…' : book.description}
                </p>
              )}
              <div className="mt-1 flex items-center gap-3 text-xs text-gray-400">
                {book.price && <span>{book.price.toLocaleString()}円</span>}
                {book.pages && <span>{book.pages}p</span>}
                {book.isbn && <span>ISBN: {book.isbn}</span>}
                <button
                  onClick={() => { if (confirm('削除しますか？')) onDelete(book.id) }}
                  className="text-red-300 hover:text-red-500 ml-auto"
                >
                  削除
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ========================================
// タブ定義
// ========================================
type TabKey = 'high' | 'watch' | 'mid' | 'all' | 'daily'

const TABS: { key: TabKey; label: string; rankFilter: string; color: string }[] = [
  { key: 'daily', label: '日別',    rankFilter: '',        color: 'emerald' },
  { key: 'high',  label: '高確率',  rankFilter: '高確率',  color: 'red' },
  { key: 'mid',   label: '中確率',  rankFilter: '中確率',  color: 'orange' },
  { key: 'watch', label: '注目',    rankFilter: '注目',    color: 'blue' },
  { key: 'all',   label: '全書籍',  rankFilter: '',        color: 'gray' },
]

export default function Dashboard() {
  const [books, setBooks] = useState<Book[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [activeTab, setActiveTab] = useState<TabKey>('daily')
  const [sort1, setSort1] = useState('release_date:asc')
  const [sort2, setSort2] = useState('rank:asc')

  // ランク別カウント（全データから算出、初回ロード時に取得）
  const [rankCounts, setRankCounts] = useState<Record<string, number>>({})
  const [todayNewBooks, setTodayNewBooks] = useState(0)
  const [todayRanks, setTodayRanks] = useState<Record<string, number>>({})
  const [releaseFilter, setReleaseFilter] = useState('') // '' | 'upcoming'
  const [checkedTodayFilter, setCheckedTodayFilter] = useState(false)
  const [statsData, setStatsData] = useState<{
    totalBooks: number
    todayChecked: number
    todayCheckedRanks: Record<string, number>
    pending: number
    rerankPending: number
    searchQuality: { withHits: number; zeroResults: number; skipped: number; hitRate: string }
    dailyStats: Array<{ date: string; newBooks: number; checked: number }>
    apiHealth?: Record<string, { status: string; detail?: string }>
  } | null>(null)

  // 初回にランク別カウントを取得
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/sns/stats')
        if (res.ok) {
          const data = await res.json()
          setRankCounts(data.rankDistribution || {})
          setTodayNewBooks(data.todayNewBooks || 0)
          setTodayRanks(data.todayRankDistribution || {})
          setStatsData({
            totalBooks: data.totalBooks || 0,
            todayChecked: data.todayChecked || 0,
            todayCheckedRanks: data.todayCheckedRanks || {},
            pending: data.pending || 0,
            rerankPending: data.rerankPending || 0,
            searchQuality: data.searchQuality || { withHits: 0, zeroResults: 0, skipped: 0, hitRate: 'N/A' },
            dailyStats: data.dailyStats || [],
            apiHealth: data.apiHealth || undefined,
          })
        }
      } catch { /* ignore */ }
    })()
  }, [])

  const fetchBooks = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (filterStatus) params.set('status', filterStatus)
    if (releaseFilter) params.set('release', releaseFilter)

    if (checkedTodayFilter) {
      // 「本日の調査完了」モード：updated_at降順で取得、クライアント側でランクソート
      params.set('checked_today', '1')
      params.set('sort', 'updated_at')
      params.set('order', 'desc')
    } else if (activeTab === 'daily') {
      // 日別一覧: 全書籍を発見日降順で取得（グルーピングはクライアント側）
      params.set('sort', 'discovered_at')
      params.set('order', 'desc')
    } else {
      // タブに応じたランクフィルタ
      const tab = TABS.find(t => t.key === activeTab)
      if (tab && tab.rankFilter) {
        params.set('rank', tab.rankFilter)
      }

      // ランク付きタブの場合はランク順、全書籍は発見日順
      if (activeTab === 'all') {
        params.set('sort', 'discovered_at')
        params.set('order', 'desc')
      } else {
        params.set('sort', 'release_date')
        params.set('order', 'asc')
      }
    }

    try {
      const res = await fetch(`/api/books?${params}`)
      const data = await res.json()
      if (Array.isArray(data)) {
        setBooks(data)
      }
    } catch (err) {
      console.error('Failed to fetch books:', err)
    } finally {
      setLoading(false)
    }
  }, [search, filterStatus, activeTab, releaseFilter, checkedTodayFilter])

  useEffect(() => {
    fetchBooks()
  }, [fetchBooks])

  // クライアント側ソート（2段階）
  // checkedTodayモード時はランク優先で固定
  const sortedBooks = (() => {
    if (checkedTodayFilter) {
      return [...books].sort((a, b) => {
        const cmp = compareByField(a, b, 'rank', 'asc')
        if (cmp !== 0) return cmp
        return compareByField(a, b, 'title', 'asc')
      })
    }
    const [f1, o1] = sort1.split(':') as [SortKey, SortDir]
    const [f2, o2] = sort2.split(':') as [SortKey, SortDir]
    return [...books].sort((a, b) => {
      const cmp1 = compareByField(a, b, f1, o1)
      if (cmp1 !== 0) return cmp1
      return compareByField(a, b, f2, o2)
    })
  })()

  const handleStatusChange = async (id: string, status: string) => {
    try {
      await fetch(`/api/books/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      setBooks(prev => prev.map(b => b.id === id ? { ...b, status: status as Book['status'] } : b))
    } catch (err) {
      console.error('Failed to update status:', err)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/books/${id}`, { method: 'DELETE' })
      setBooks(prev => prev.filter(b => b.id !== id))
    } catch (err) {
      console.error('Failed to delete:', err)
    }
  }

  // --- SNS 一括調査 ---
  const [snsRunning, setSnsRunning] = useState(false)
  const [snsProgress, setSnsProgress] = useState({ processed: 0, remaining: 0, errors: 0, message: '' })
  const snsAbort = useState<AbortController | null>(null)

  const startSnsBatch = useCallback(async () => {
    if (snsRunning) return
    setSnsRunning(true)
    setSnsProgress({ processed: 0, remaining: 0, errors: 0, message: '開始中...' })
    const controller = new AbortController()
    snsAbort[1](controller)
    let totalProcessed = 0
    let errors = 0
    let consecutiveErrors = 0
    const MAX_RETRIES = 3

    try {
      while (!controller.signal.aborted) {
        let data: { processed?: number; remaining?: number; results?: Array<{ error?: string }>; quotaExhausted?: boolean; quotaError?: string; error?: string } | null = null

        for (let retry = 0; retry <= MAX_RETRIES; retry++) {
          try {
            const res = await fetch('/api/sns/check?limit=1', {
              signal: controller.signal,
            })

            if (res.status === 429) {
              setSnsProgress(prev => ({
                ...prev,
                message: `⚠️ APIクォータ超過 — ${totalProcessed}冊完了、残りは明日再開されます`,
              }))
              return
            }

            if (!res.ok) {
              if (retry < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 3000 * (retry + 1)))
                continue
              }
              consecutiveErrors++
              break
            }

            data = await res.json()
            consecutiveErrors = 0
            break
          } catch (e) {
            if (controller.signal.aborted) return
            if (retry < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 3000 * (retry + 1)))
              continue
            }
            consecutiveErrors++
          }
        }

        if (consecutiveErrors >= 5) {
          setSnsProgress(prev => ({
            ...prev,
            message: `❌ 連続エラーにより停止（${totalProcessed}冊完了）`,
          }))
          return
        }

        if (!data) {
          await new Promise(r => setTimeout(r, 5000))
          continue
        }

        if (data.quotaExhausted) {
          totalProcessed += data.processed || 0
          setSnsProgress({
            processed: totalProcessed,
            remaining: data.remaining || 0,
            errors,
            message: `⚠️ APIクォータ超過 — ${totalProcessed}冊完了`,
          })
          return
        }

        totalProcessed += data.processed || 0
        if (data.results) {
          errors += data.results.filter((r) => r.error).length
        }
        setSnsProgress({
          processed: totalProcessed,
          remaining: data.remaining || 0,
          errors,
          message: '',
        })

        if (data.remaining === 0 || data.processed === 0) break

        if (totalProcessed > 0 && totalProcessed % 50 < 3) {
          fetchBooks()
        }

        await new Promise(r => setTimeout(r, 3000))
      }
    } catch (e) {
      if (!(e instanceof DOMException && (e as DOMException).name === 'AbortError')) {
        console.error('[SNS batch] unexpected error:', e)
      }
    } finally {
      setSnsRunning(false)
      fetchBooks()
    }
  }, [snsRunning, fetchBooks, snsAbort])

  const stopSnsBatch = useCallback(() => {
    snsAbort[0]?.abort()
  }, [snsAbort])

  // ページロード時に未調査書籍があれば自動開始
  const [autoStartChecked, setAutoStartChecked] = useState(false)
  const [resetCandidates, setResetCandidates] = useState(0)

  useEffect(() => {
    if (autoStartChecked || loading || snsRunning) return
    setAutoStartChecked(true)
    const checkAndStart = async () => {
      try {
        const res = await fetch('/api/sns/check?limit=0')
        if (!res.ok) return
        const data = await res.json()
        if (data.remaining && data.remaining > 0) {
          setTimeout(() => startSnsBatch(), 1500)
        }
      } catch { /* ignore */ }

      // 結果0件の候補数も取得
      try {
        const res2 = await fetch('/api/sns/reset-empty')
        if (res2.ok) {
          const data2 = await res2.json()
          setResetCandidates(data2.resetCandidates || 0)
        }
      } catch { /* ignore */ }
    }
    checkAndStart()
  }, [autoStartChecked, loading, snsRunning, startSnsBatch])

  const handleResetAndRecheck = async () => {
    if (snsRunning) return
    if (!confirm(`検索結果0件の${resetCandidates}件をリセットして再調査しますか？`)) return
    try {
      const res = await fetch('/api/sns/reset-empty', { method: 'POST' })
      const data = await res.json()
      alert(`${data.reset}件をリセットしました。自動調査を開始します。`)
      setResetCandidates(0)
      fetchBooks()
      setTimeout(() => startSnsBatch(), 1000)
    } catch (e) {
      alert('リセットに失敗しました: ' + String(e))
    }
  }

  const currentTabCount = books.length
  const totalRanked = (rankCounts['高確率'] || 0) + (rankCounts['注目'] || 0) + (rankCounts['中確率'] || 0)

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ヘッダー */}
      <header className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold text-gray-900">新刊モニタリング</h1>
              <p className="text-xs text-gray-500">
                著者SNS影響力による販売見込み判定 — ランク付き {totalRanked}件
                {todayNewBooks > 0 && (
                  <span className="ml-2 px-2 py-0.5 bg-green-100 text-green-700 rounded-full font-medium">
                    本日 +{todayNewBooks}件
                    {(todayRanks['高確率'] || todayRanks['注目'] || todayRanks['中確率']) ? (
                      <span className="ml-1 text-green-600 font-normal">
                        （{[
                          todayRanks['高確率'] ? `高確率${todayRanks['高確率']}` : '',
                          todayRanks['注目'] ? `注目${todayRanks['注目']}` : '',
                          todayRanks['中確率'] ? `中確率${todayRanks['中確率']}` : '',
                        ].filter(Boolean).join('・')}）
                      </span>
                    ) : null}
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              {snsRunning && (
                <div className="flex items-center gap-2">
                  <div className="animate-spin w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full" />
                  <span className="text-indigo-600 font-medium">
                    調査中 {snsProgress.processed}冊 / 残{snsProgress.remaining}
                  </span>
                  <button onClick={stopSnsBatch} className="px-2 py-0.5 bg-gray-200 text-gray-600 rounded hover:bg-gray-300">
                    停止
                  </button>
                </div>
              )}
              {!snsRunning && snsProgress.message && (
                <span className="text-orange-600">{snsProgress.message}</span>
              )}
              {!snsRunning && resetCandidates > 0 && (
                <button
                  onClick={handleResetAndRecheck}
                  className="px-3 py-1 bg-amber-500 text-white rounded-md hover:bg-amber-600 transition-colors text-xs font-medium"
                >
                  結果0件を再調査（{resetCandidates}件）
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* 本日の処理状況パネル */}
      {statsData && (
        <>
        {/* API健全性アラート */}
        {statsData?.apiHealth && (() => {
          const errors = Object.entries(statsData.apiHealth).filter(([, v]) => v.status === 'error')
          const warnings = Object.entries(statsData.apiHealth).filter(([, v]) => v.status === 'warning')
          const serperOk = statsData.apiHealth.serper?.status === 'ok'
          return (
            <>
              {errors.length > 0 && (
                <div className="bg-red-50 border-b border-red-200">
                  <div className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-2">
                    <span className="text-red-600 font-bold text-sm">&#9888; 検索API障害</span>
                    <span className="text-red-500 text-xs">
                      {errors.map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1)}${v.detail ? ` (${v.detail})` : ''}`).join(', ')}
                      {!serperOk ? ' — SNS調査が停止しています。APIキーの更新が必要です。' : ''}
                    </span>
                  </div>
                </div>
              )}
              {warnings.length > 0 && errors.length === 0 && (
                <div className="bg-yellow-50 border-b border-yellow-200">
                  <div className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-2">
                    <span className="text-yellow-600 font-medium text-sm">&#9432; フォールバックAPI制限中</span>
                    <span className="text-yellow-600 text-xs">
                      {warnings.map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1)}: ${v.detail || '制限中'}`).join(', ')}
                      {serperOk ? ' — メイン検索(Serper)は正常稼働中' : ''}
                    </span>
                  </div>
                </div>
              )}
            </>
          )
        })()}
        <div className="bg-gradient-to-r from-slate-50 to-blue-50 border-b">
          <div className="max-w-6xl mx-auto px-4 py-3">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {/* 全体 */}
              <div className="bg-white rounded-lg p-3 shadow-sm border">
                <div className="text-xs text-gray-500 mb-1">総登録数</div>
                <div className="text-xl font-bold text-gray-900">{statsData.totalBooks.toLocaleString()}</div>
              </div>
              {/* 本日の新着 */}
              <div className="bg-white rounded-lg p-3 shadow-sm border">
                <div className="text-xs text-gray-500 mb-1">本日の新着</div>
                <div className="text-xl font-bold text-green-600">+{todayNewBooks}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {todayNewBooks > 0 ? 'cron検出' : 'cron未実行 or 新刊なし'}
                </div>
              </div>
              {/* 本日の調査完了 */}
              <div
                className={`bg-white rounded-lg p-3 shadow-sm border cursor-pointer transition-all hover:shadow-md ${
                  checkedTodayFilter ? 'ring-2 ring-blue-400 bg-blue-50' : ''
                }`}
                onClick={() => {
                  setCheckedTodayFilter(!checkedTodayFilter)
                }}
                title="クリックで本日の調査結果をランク順に表示"
              >
                <div className="text-xs text-gray-500 mb-1">
                  本日の調査完了
                  {checkedTodayFilter && <span className="ml-1 text-blue-500 font-medium">（表示中）</span>}
                </div>
                <div className="text-xl font-bold text-blue-600">{statsData.todayChecked}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {(() => {
                    const cr = statsData.todayCheckedRanks
                    const parts = [
                      cr['高確率'] ? `高${cr['高確率']}` : '',
                      cr['中確率'] ? `中${cr['中確率']}` : '',
                      cr['注目'] ? `注${cr['注目']}` : '',
                    ].filter(Boolean)
                    return parts.length > 0 ? parts.join(' / ') : 'ランク付きなし'
                  })()}
                </div>
              </div>
              {/* 未調査 */}
              <div className={`bg-white rounded-lg p-3 shadow-sm border ${statsData.pending > 0 ? 'ring-1 ring-amber-200' : ''}`}>
                <div className="text-xs text-gray-500 mb-1">未調査（残り）</div>
                <div className={`text-xl font-bold ${statsData.pending > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                  {statsData.pending > 0 ? statsData.pending : '0'}
                </div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {statsData.pending === 0 ? '全件チェック済み' : '自動調査中...'}
                </div>
              </div>
              {/* 7日間ミニグラフ */}
              <div className="bg-white rounded-lg p-3 shadow-sm border">
                <div className="text-xs text-gray-500 mb-1">過去7日間の新着</div>
                <div className="flex items-end gap-0.5 h-8">
                  {statsData.dailyStats.map((d, i) => {
                    const max = Math.max(...statsData.dailyStats.map(s => s.newBooks), 1)
                    const h = Math.max((d.newBooks / max) * 100, 4)
                    const isToday = i === statsData.dailyStats.length - 1
                    return (
                      <div key={d.date} className="flex-1 flex flex-col items-center gap-0.5" title={`${d.date}: 新着${d.newBooks}件 / 調査${d.checked}件`}>
                        <div
                          className={`w-full rounded-sm ${isToday ? 'bg-green-500' : 'bg-blue-300'}`}
                          style={{ height: `${h}%` }}
                        />
                      </div>
                    )
                  })}
                </div>
                <div className="flex justify-between text-[10px] text-gray-300 mt-0.5">
                  <span>{statsData.dailyStats[0]?.date.slice(5)}</span>
                  <span>今日</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        </>
      )}

      {/* タブ */}
      <div className="bg-white border-b">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex gap-0">
            {TABS.map(tab => {
              const count = tab.key === 'all'
                ? Object.values(rankCounts).reduce((a, b) => a + b, 0)
                : (rankCounts[tab.rankFilter] || 0)
              const isActive = !checkedTodayFilter && activeTab === tab.key
              return (
                <button
                  key={tab.key}
                  onClick={() => { setActiveTab(tab.key); setCheckedTodayFilter(false) }}
                  className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                    isActive
                      ? `border-${tab.color}-500 text-${tab.color}-700 bg-${tab.color}-50`
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                  }`}
                  style={isActive ? {
                    borderBottomColor: tab.color === 'emerald' ? '#10b981' : tab.color === 'red' ? '#ef4444' : tab.color === 'blue' ? '#3b82f6' : tab.color === 'orange' ? '#f97316' : '#6b7280',
                    backgroundColor: tab.color === 'emerald' ? '#ecfdf5' : tab.color === 'red' ? '#fef2f2' : tab.color === 'blue' ? '#eff6ff' : tab.color === 'orange' ? '#fff7ed' : '#f9fafb',
                    color: tab.color === 'emerald' ? '#065f46' : tab.color === 'red' ? '#b91c1c' : tab.color === 'blue' ? '#1d4ed8' : tab.color === 'orange' ? '#c2410c' : '#374151',
                  } : {}}
                >
                  {tab.label}
                  <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-xs ${
                    isActive ? 'bg-white/60' : 'bg-gray-100'
                  }`}>
                    {count}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* フィルタ・ソート */}
      <div className="bg-white border-b">
        <div className="max-w-6xl mx-auto px-4 py-2">
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              placeholder="タイトル・著者・出版社で検索..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 min-w-[200px] px-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="px-3 py-1.5 text-sm border rounded-md bg-white"
            >
              <option value="">全ステータス</option>
              {STATUS_OPTIONS.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <button
              onClick={() => setReleaseFilter(releaseFilter === 'upcoming' ? '' : 'upcoming')}
              className={`px-3 py-1.5 text-sm border rounded-md transition-colors ${
                releaseFilter === 'upcoming'
                  ? 'bg-indigo-100 text-indigo-700 border-indigo-300 font-medium'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              発売前のみ
            </button>
            <select
              value={sort1}
              onChange={(e) => setSort1(e.target.value)}
              className="px-3 py-1.5 text-sm border rounded-md bg-white"
            >
              <option value="release_date:asc">発売日（近い順）</option>
              <option value="release_date:desc">発売日（遠い順）</option>
              <option value="rank:asc">ランク（高→低）</option>
              <option value="discovered_at:desc">発見日（新しい順）</option>
              <option value="discovered_at:asc">発見日（古い順）</option>
              <option value="title:asc">タイトル（A→Z）</option>
            </select>
            <span className="text-xs text-gray-400">→</span>
            <select
              value={sort2}
              onChange={(e) => setSort2(e.target.value)}
              className="px-3 py-1.5 text-sm border rounded-md bg-white"
            >
              <option value="rank:asc">ランク（高→低）</option>
              <option value="release_date:asc">発売日（近い順）</option>
              <option value="release_date:desc">発売日（遠い順）</option>
              <option value="discovered_at:desc">発見日（新しい順）</option>
              <option value="title:asc">タイトル（A→Z）</option>
            </select>
            <span className="text-xs text-gray-400">{currentTabCount}件表示</span>
          </div>
        </div>
      </div>

      {/* 書籍一覧 */}
      <main className="max-w-6xl mx-auto px-4 py-6">
        {loading ? (
          <div className="text-center py-12 text-gray-400">読み込み中...</div>
        ) : books.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-400 text-lg mb-2">該当する書籍がありません</p>
            <p className="text-gray-300 text-sm">
              {activeTab !== 'all' ? '別のタブを確認するか、' : ''}
              フィルタ条件を変更してください
            </p>
          </div>
        ) : activeTab === 'daily' ? (
          <DailyView
            books={books}
            onStatusChange={handleStatusChange}
            onDelete={handleDelete}
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {sortedBooks.map(book => (
              <BookCard
                key={book.id}
                book={book}
                onStatusChange={handleStatusChange}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
