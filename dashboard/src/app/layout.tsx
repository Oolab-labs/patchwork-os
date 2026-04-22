import type { ReactNode } from "react";
import "./globals.css";
import { Shell } from "@/components/Shell";

export const metadata = {
  title: "Patchwork",
  description: "AI agent oversight and approval dashboard",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
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
    <html lang="en">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0a0a0a" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
      </head>
      <body>
        <Shell>{children}</Shell>
        {/* SW registration — runs client-side only */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>{})}`,
          }}
        />
      </body>
    </html>
  );
}
