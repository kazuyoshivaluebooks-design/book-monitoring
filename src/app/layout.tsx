import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "新刊モニタリング | バリューブックス",
  description: "著者SNS影響力による予約100冊見込み書籍の早期発見ダッシュボード",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
