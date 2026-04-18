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
const RANK_OPTIONS = ['高確率', '中確率', '注目'] as const

// ランクの優先度（数値が小さいほど上位）
const RANK_PRIORITY: Record<string, number> = {
  '高確率': 1,
  '中確率': 2,
  '注目': 3,
}
const RANK_NONE = 99 // ランクなし

type SortKey = 'discovered_at' | 'release_date' | 'title' | 'rank'
type SortDir = 'asc' | 'desc'
type SortOption = { field: SortKey; order: SortDir; label: string }

const SORT_OPTIONS: SortOption[] = [
  { field: 'discovered_at', order: 'desc', label: '発見日（新しい順）' },
  { field: 'discovered_at', order: 'asc',  label: '発見日（古い順）' },
  { field: 'release_date',  order: 'asc',  label: '発売日（近い順）' },
  { field: 'release_date',  order: 'desc', label: '発売日（遠い順）' },
  { field: 'rank',          order: 'asc',  label: 'ランク（高→低）' },
  { field: 'rank',          order: 'desc', label: 'ランク（低→高）' },
  { field: 'title',         order: 'asc',  label: 'タイトル（A→Z）' },
]

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
    // title
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

  const entries = platforms.filter(p => {
    return getCount(snsData[p.key], p.field) > 0
  })

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

      <SnsInfo snsData={book.sns_data || {}} />

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
            {book.source && (
              <div><span className="text-gray-400">ソース:</span> {book.source}</div>
            )}
            <div>
              <span className="text-gray-400">発見日:</span>{' '}
              {new Date(book.discovered_at).toLocaleDateString('ja-JP')}
            </div>
          </div>
          {book.evaluation_reason && (
            <div className="bg-amber-50 rounded p-2 text-xs text-amber-800">
              <span className="font-bold">判定根拠:</span> {book.evaluation_reason}
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

export default function Dashboard() {
  const [books, setBooks] = useState<Book[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterRank, setFilterRank] = useState('')
  const [sort1, setSort1] = useState('release_date:desc')
  const [sort2, setSort2] = useState('') // 2nd sort（空＝なし）

  const fetchBooks = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (filterStatus) params.set('status', filterStatus)
    if (filterRank) params.set('rank', filterRank)
    // APIからはdiscovered_at descで全件取得し、クライアントでソート
    params.set('sort', 'discovered_at')
    params.set('order', 'desc')

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
  }, [search, filterStatus, filterRank])

  // クライアント側で2段階ソート
  const sortedBooks = (() => {
    const [f1, o1] = sort1.split(':') as [SortKey, SortDir]
    const hasSort2 = sort2 !== ''
    const [f2, o2] = hasSort2 ? (sort2.split(':') as [SortKey, SortDir]) : ['discovered_at' as SortKey, 'desc' as SortDir]

    return [...books].sort((a, b) => {
      const cmp1 = compareByField(a, b, f1, o1)
      if (cmp1 !== 0) return cmp1
      if (hasSort2) return compareByField(a, b, f2, o2)
      return 0
    })
  })()

  useEffect(() => {
    fetchBooks()
  }, [fetchBooks])

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

  const stats = {
    total: books.length,
    highProb: books.filter(b => b.rank === '高確率').length,
    midProb: books.filter(b => b.rank === '中確率').length,
    pending: books.filter(b => b.status === '未対応').length,
    ordered: books.filter(b => b.status === '仕入済').length,
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold text-gray-900">新刊モニタリング</h1>
              <p className="text-xs text-gray-500">著者SNS影響力による予約100冊見込み書籍</p>
            </div>
            <div className="flex gap-4 text-xs text-gray-500">
              <span>全{stats.total}件</span>
              <span className="text-red-600">高確率 {stats.highProb}</span>
              <span className="text-orange-600">中確率 {stats.midProb}</span>
              <span>未対応 {stats.pending}</span>
              <span className="text-green-600">仕入済 {stats.ordered}</span>
            </div>
          </div>
        </div>
      </header>

      <div className="bg-white border-b">
        <div className="max-w-6xl mx-auto px-4 py-3">
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
              value={filterRank}
              onChange={(e) => setFilterRank(e.target.value)}
              className="px-3 py-1.5 text-sm border rounded-md bg-white"
            >
              <option value="">全ランク</option>
              {RANK_OPTIONS.map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <select
              value={sort1}
              onChange={(e) => setSort1(e.target.value)}
              className="px-3 py-1.5 text-sm border rounded-md bg-white"
            >
              {SORT_OPTIONS.map(opt => (
                <option key={`${opt.field}:${opt.order}`} value={`${opt.field}:${opt.order}`}>
                  {opt.label}
                </option>
              ))}
            </select>
            <select
              value={sort2}
              onChange={(e) => setSort2(e.target.value)}
              className="px-3 py-1.5 text-sm border rounded-md bg-white text-gray-500"
            >
              <option value="">次に...</option>
              {SORT_OPTIONS
                .filter(opt => `${opt.field}:${opt.order}` !== sort1)
                .map(opt => (
                  <option key={`${opt.field}:${opt.order}`} value={`${opt.field}:${opt.order}`}>
                    → {opt.label}
                  </option>
                ))}
            </select>
          </div>
        </div>
      </div>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {loading ? (
          <div className="text-center py-12 text-gray-400">読み込み中...</div>
        ) : books.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-400 text-lg mb-2">書籍が見つかりません</p>
            <p className="text-gray-300 text-sm">フィルタ条件を変更するか、モニタリングタスクの実行をお待ちください</p>
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
