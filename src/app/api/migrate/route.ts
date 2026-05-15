import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// GET /api/migrate — description, cover_url, pages カラム追加
export async function GET() {
  const results: string[] = []

  // description カラム追加
  const { error: e1 } = await supabase.rpc('exec_sql', {
    sql: "ALTER TABLE books ADD COLUMN IF NOT EXISTS description text"
  }).maybeSingle()
  if (e1) {
    // rpc が使えない場合は直接 insert で確認
    results.push(`description: rpc failed (${e1.message}), trying insert test...`)
    const { error: testErr } = await supabase
      .from('books')
      .update({ description: 'test' })
      .eq('id', '00000000-0000-0000-0000-000000000000')
    if (testErr?.message?.includes('column')) {
      results.push('description: column does not exist yet - needs manual creation')
    } else {
      results.push('description: column already exists')
    }
  } else {
    results.push('description: OK')
  }

  // cover_url カラム追加
  const { error: e2 } = await supabase
    .from('books')
    .update({ cover_url: 'test' })
    .eq('id', '00000000-0000-0000-0000-000000000000')
  if (e2?.message?.includes('column')) {
    results.push('cover_url: column does not exist yet - needs manual creation')
  } else {
    results.push('cover_url: column already exists or update succeeded')
  }

  // pages カラム追加
  const { error: e3 } = await supabase
    .from('books')
    .update({ pages: 0 })
    .eq('id', '00000000-0000-0000-0000-000000000000')
  if (e3?.message?.includes('column')) {
    results.push('pages: column does not exist yet - needs manual creation')
  } else {
    results.push('pages: column already exists or update succeeded')
  }

  return NextResponse.json({ results })
}
