import type { ReactNode } from "react";
import { Albert_Sans, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Shell } from "@/components/Shell";
import { DemoBanner } from "@/components/DemoBanner";
import { BridgeBanner } from "@/components/BridgeBanner";
import { MobileBottomNav } from "@/components/MobileBottomNav";

const albertSans = Albert_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-geist",
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains",
  display: "swap",
});

// Favicon paths must include the `/dashboard/` basePath explicitly — Next.js
// metadata icons aren't auto-prefixed for absolute URLs, so without this the
// browser fetches `/favicon.svg` (404, no basePath) instead of
// `/dashboard/favicon.svg`. Same for the manifest file.
export const metadata = {
  icons: {
    icon: [
      { url: "/dashboard/favicon.svg", type: "image/svg+xml" },
      { url: "/dashboard/favicon.ico" },
    ],
  },
  title: "Patchwork",
  description: "AI agent oversight and approval dashboard",
  manifest: "/dashboard/manifest.json",
  appleWebApp: {
    statusBarStyle: "black-translucent",
    title: "Patchwork",
  },
  openGraph: {
    type: "website",
    title: "Patchwork",
    description: "AI agent oversight and approval dashboard",
    siteName: "Patchwork",
    images: [{ url: "/dashboard/icons/icon-512.png", width: 512, height: 512, alt: "Patchwork" }],
  },
  twitter: {
    card: "summary",
    title: "Patchwork",
    description: "AI agent oversight and approval dashboard",
    images: ["/dashboard/icons/icon-512.png"],
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  minimumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${albertSans.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable}`}>
      <head>
        <meta name="theme-color" content="#faf7f2" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#0d0c0b" media="(prefers-color-scheme: dark)" />
        <meta name="mobile-web-app-capable" content="yes" />
        <link rel="apple-touch-icon" href="/dashboard/icons/icon-192.png" />
      </head>
      <body>
        <DemoBanner />
        <BridgeBanner />
        <Shell>{children}</Shell>
        <MobileBottomNav />
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){navigator.serviceWorker.register('/dashboard/sw.js',{scope:'/dashboard/'}).catch(()=>{})}`,
          }}
        />
      </body>
    </html>
  );
}
