import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { localeCookie } from "@/i18n/config";
import { getLocaleFromAcceptLanguage, normalizeLocale } from "@/i18n/locale";

export const metadata: Metadata = {
  title: "inkfellow",
  description: "inkfellow — Personal knowledge base powered by LLM Wiki",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16" },
      { url: "/icons/inkfellow-pwa-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/inkfellow-pwa-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "inkfellow",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // 键盘弹出时压缩 layout viewport，dvh / position:fixed 自动跟随，
  // 底部对话抽屉不会被键盘盖住。iOS Safari 尚不支持这个属性，
  // 那边由 NotesExplorer 的 --keyboard-height 兜底。
  interactiveWidget: "resizes-content",
  themeColor: "#000000",
};

const resolveLocale = async () => {
  const headerList = await headers();
  const cookieStore = await cookies();
  const headerLocale = normalizeLocale(headerList.get("x-locale"));
  if (headerLocale) {
    return headerLocale;
  }
  const cookieLocale = normalizeLocale(cookieStore.get(localeCookie)?.value);
  if (cookieLocale) {
    return cookieLocale;
  }
  return getLocaleFromAcceptLanguage(headerList.get("accept-language"));
};

const cloudflareWebAnalyticsToken = process.env.NEXT_PUBLIC_CF_WEB_ANALYTICS_TOKEN?.trim();

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await resolveLocale();
  return (
    <html lang={locale}>
      <body className="antialiased">
        {children}
        {cloudflareWebAnalyticsToken ? (
          <Script
            defer
            src="https://static.cloudflareinsights.com/beacon.min.js"
            data-cf-beacon={JSON.stringify({ token: cloudflareWebAnalyticsToken })}
            strategy="afterInteractive"
          />
        ) : null}
      </body>
    </html>
  );
}
