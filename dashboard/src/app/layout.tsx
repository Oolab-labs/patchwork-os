import type { ReactNode } from "react";
import { Albert_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Shell } from "@/components/Shell";
import { DemoBanner } from "@/components/DemoBanner";

const albertSans = Albert_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-albert",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata = {
  title: "Patchwork",
  description: "AI agent oversight and approval dashboard",
  manifest: "/dashboard/manifest.json",
  appleWebApp: {
    statusBarStyle: "black-translucent",
    title: "Patchwork",
  },
  viewport: {
    width: "device-width",
    initialScale: 1,
    minimumScale: 1,
    viewportFit: "cover",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${albertSans.variable} ${jetbrainsMono.variable}`}>
      <head>
        <link rel="manifest" href="/dashboard/manifest.json" />
        <meta name="theme-color" content="#faf7f2" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#0d0c0b" media="(prefers-color-scheme: dark)" />
        <meta name="mobile-web-app-capable" content="yes" />
        <link rel="apple-touch-icon" href="/dashboard/icons/icon-192.png" />
      </head>
      <body>
        <DemoBanner />
        <Shell>{children}</Shell>
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){navigator.serviceWorker.register('/dashboard/sw.js',{scope:'/dashboard/'}).catch(()=>{})}`,
          }}
        />
      </body>
    </html>
  );
}
