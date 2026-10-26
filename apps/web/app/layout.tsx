import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "ABA Plan Assistant", robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="text-slate-800 antialiased">{children}</body>
    </html>
  );
}
