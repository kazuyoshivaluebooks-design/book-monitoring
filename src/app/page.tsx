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
  '注目': 2,
  '中確率': 3,
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

  const entries = platforms.filter(p => getCount(snsData[p.key], p.field) > 0)

  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(p => {
        const count = getCount(snsData[p.key], p.field)
        const url = getUrl(snsData[p.key])
        const badge = (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-indigo-50 text-indigo-700 ${url ? 'hover:bg-indigo-100 cursor-pointer' : ''}`}>
            {p.label}: {formatFollowers(count)}
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

function BookCover({ isbn }: { isbn: string | null }) {
  const [status, setStatus] = useState<'loading' | 'ok' | 'none'>('loading')

  useEffect(() => {
    if (!isbn) { setStatus('none'); return }
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      setStatus(img.naturalWidth < 10 ? 'none' : 'ok')
    }
    img.onerror = () => { if (!cancelled) setStatus('none') }
    img.src = `https://cover.openbd.jp/${isbn}.jpg`
    const timer = setTimeout(() => { if (!cancelled) setStatus('none') }, 5000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [isbn])

  if (!isbn || status === 'none') {
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
      src={`https://cover.openbd.jp/${isbn}.jpg`}
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
        <BookCover isbn={book.isbn} />
        <div className="flex-1 min-w-0">
          <h3
            className="font-bold text-base mb-1 cursor-pointer hover:text-indigo-600"
            onClick={() => setShowDetail(!showDetail)}
          >
            {book.title}
          </h3>
          <p className="text-sm text-gray-600 mb-1">
            {book.author}
            {book.publisher && <span className="text-gray-400"> / {book.publisher}</span>}
          </p>
          {book.release_date && (
            <span className="inline-block text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600 mb-2">
              📅 {book.release_date.replace(/-/g, '/')}
            </span>
          )}
        </div>
      </div>

      <SnsInfo snsData={book.sns_data || {}} />

      {book.evaluation_reason && (
        <div className="mt-2 bg-amber-50 rounded p-2 text-xs text-amber-800 line-clamp-3">
          <span className="font-bold">判定根拠:</span> {book.evaluation_reason}
        </div>
      )}

      {showDetail && (
        <div className="mt-3 pt-3 border-t border-gray-100 space-y-2 text-sm">
          {book.evaluation_reason && (
            <div className="bg-amber-50 rounded p-2 text-xs text-amber-800">
              <span className="font-bold">判定根拠（全文）:</span> {book.evaluation_reason}
            </div>
          )}
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
            {book.source && (
              <div><span className="text-gray-400">ソース:</span> {book.source}</div>
            )}
            <div>
              <span className="text-gray-400">発見日:</span>{' '}
              {new Date(book.discovered_at).toLocaleDateString('ja-JP')}
            </div>
          </div>
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
// タブ定義
// ========================================
type TabKey = 'high' | 'watch' | 'mid' | 'all'

const TABS: { key: TabKey; label: string; rankFilter: string; color: string }[] = [
  { key: 'high',  label: '高確率',  rankFilter: '高確率',  color: 'red' },
  { key: 'watch', label: '注目',    rankFilter: '注目',    color: 'blue' },
  { key: 'mid',   label: '中確率',  rankFilter: '中確率',  color: 'orange' },
  { key: 'all',   label: '全書籍',  rankFilter: '',        color: 'gray' },
]

export default function Dashboard() {
  const [books, setBooks] = useState<Book[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [activeTab, setActiveTab] = useState<TabKey>('high')
  const [sort1, setSort1] = useState('release_date:asc')

  // ランク別カウント（全データから算出、初回ロード時に取得）
  const [rankCounts, setRankCounts] = useState<Record<string, number>>({})

  // 初回にランク別カウントを取得
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/sns/stats')
        if (res.ok) {
          const data = await res.json()
          setRankCounts(data.rankDistribution || {})
        }
      } catch { /* ignore */ }
    })()
  }, [])

  const fetchBooks = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (filterStatus) params.set('status', filterStatus)

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
  }, [search, filterStatus, activeTab])

  useEffect(() => {
    fetchBooks()
  }, [fetchBooks])

  // クライアント側ソート
  const sortedBooks = (() => {
    const [f1, o1] = sort1.split(':') as [SortKey, SortDir]
    return [...books].sort((a, b) => {
      // まずランク優先度で
      const rankCmp = (RANK_PRIORITY[a.rank || ''] ?? RANK_NONE) - (RANK_PRIORITY[b.rank || ''] ?? RANK_NONE)
      if (rankCmp !== 0 && activeTab === 'all') return rankCmp
      // 次に指定ソート
      return compareByField(a, b, f1, o1)
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
              <p className="text-xs text-gray-500">著者SNS影響力による販売見込み判定 — ランク付き {totalRanked}件</p>
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

      {/* タブ */}
      <div className="bg-white border-b">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex gap-0">
            {TABS.map(tab => {
              const count = tab.key === 'all'
                ? Object.values(rankCounts).reduce((a, b) => a + b, 0)
                : (rankCounts[tab.rankFilter] || 0)
              const isActive = activeTab === tab.key
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                    isActive
                      ? `border-${tab.color}-500 text-${tab.color}-700 bg-${tab.color}-50`
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                  }`}
                  style={isActive ? {
                    borderBottomColor: tab.color === 'red' ? '#ef4444' : tab.color === 'blue' ? '#3b82f6' : tab.color === 'orange' ? '#f97316' : '#6b7280',
                    backgroundColor: tab.color === 'red' ? '#fef2f2' : tab.color === 'blue' ? '#eff6ff' : tab.color === 'orange' ? '#fff7ed' : '#f9fafb',
                    color: tab.color === 'red' ? '#b91c1c' : tab.color === 'blue' ? '#1d4ed8' : tab.color === 'orange' ? '#c2410c' : '#374151',
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
            <select
              value={sort1}
              onChange={(e) => setSort1(e.target.value)}
              className="px-3 py-1.5 text-sm border rounded-md bg-white"
            >
              <option value="release_date:asc">発売日（近い順）</option>
              <option value="release_date:desc">発売日（遠い順）</option>
              <option value="discovered_at:desc">発見日（新しい順）</option>
              <option value="discovered_at:asc">発見日（古い順）</option>
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
