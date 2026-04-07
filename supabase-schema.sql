-- Supabase SQL: books テーブル作成
-- Supabaseダッシュボード > SQL Editor でこのSQLを実行してください

-- booksテーブル
create table books (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  author text not null,
  publisher text,
  isbn text,
  price integer,
  release_date date,
  c_code text,
  genre text,
  rank text check (rank in ('高確率', '中確率', '注目')),
  status text default '未対応' check (status in ('未対応', '仕入検討中', '仕入済', '見送り')),
  sns_data jsonb default '{}',
  -- sns_data の形式:
  -- {
  --   "x": {"followers": 100000, "url": "https://x.com/..."},
  --   "instagram": {"followers": 89000, "url": "https://instagram.com/..."},
  --   "youtube": {"subscribers": 50000, "url": "https://youtube.com/..."},
  --   "tiktok": {"followers": 0},
  --   "voicy": {"followers": 80000},
  --   "note": {"followers": 0},
  --   "other": "テレビレギュラー出演中"
  -- }
  evaluation_reason text,
  source text,
  discovered_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- updated_at 自動更新トリガー
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger books_updated_at
  before update on books
  for each row
  execute function update_updated_at();

-- インデックス
create index idx_books_status on books(status);
create index idx_books_rank on books(rank);
create index idx_books_release_date on books(release_date);
create index idx_books_isbn on books(isbn);
create index idx_books_author on books(author);

-- RLS（Row Level Security）設定
-- 開発段階では全アクセス許可。本番ではAPI Keyで制御
alter table books enable row level security;

create policy "Allow all access" on books
  for all
  using (true)
  with check (true);

-- サンプルデータ（動作確認用）
insert into books (title, author, publisher, isbn, price, release_date, genre, rank, status, sns_data, evaluation_reason, source) values
(
  '見えない戦争の正体──米中露が仕掛ける「認知戦」',
  '苫米地英人',
  'サイゾー',
  '978-4-86625-xxx',
  1980,
  '2026-04-09',
  'ビジネス',
  '高確率',
  '未対応',
  '{"x": {"followers": 199000, "url": "https://x.com/DrTomabechi"}, "youtube": {"subscribers": 100000}}',
  'YouTube登録者10万+、認知戦・地政学は時流テーマ、前著実績あり',
  '版元ドットコム'
),
(
  '北極星 僕たちはどう働くか',
  '西野亮廣',
  '幻冬舎',
  '978-4-344-xxxxx',
  1980,
  '2026-03-12',
  'ビジネス',
  '高確率',
  '仕入済',
  '{"x": {"followers": 378000}, "facebook": {"followers": 237000}, "voicy": {"followers": 80000}, "youtube": {"subscribers": 50000}}',
  '初版10万部→12万部に増刷、オリコン週間1位、SNS総フォロワー100万超',
  '版元ドットコム'
),
(
  'マタギドライヴ：計算機自然の辺縁における脱人間知性的文明論',
  '落合陽一',
  'PLANETS',
  '978-4-911149-04-1',
  2800,
  '2026-03-31',
  '人文・教養',
  '高確率',
  '未対応',
  '{"x": {"followers": 967000}, "instagram": {"followers": 89000}}',
  'X約97万フォロワー、7年間の知的格闘の集大成',
  '版元ドットコム'
),
(
  '理不尽仕事論 「クソが!!」と思った時に読む本',
  '坂井風太・ぐんぴぃ',
  '文藝春秋',
  '978-4-16-xxxxxx',
  1760,
  '2026-04-10',
  'ビジネス',
  '中確率',
  '未対応',
  '{"youtube": {"subscribers": 1980000, "url": "https://youtube.com/バキ童チャンネル"}}',
  'ぐんぴぃ（バキ童チャンネル）YouTube登録者198万人の発信力',
  '版元ドットコム'
),
(
  '世界の「なぜ？」が見えてくる 大人の地政学 ざっと丸わかり',
  'すあし社長',
  'KADOKAWA',
  '978-4-04-811845-3',
  1800,
  '2026-06-05',
  'ビジネス',
  '注目',
  '未対応',
  '{"youtube": {"subscribers": 30000}}',
  'YouTube登録3万、地政学テーマは需要あり。要継続ウォッチ',
  '版元ドットコム'
);
