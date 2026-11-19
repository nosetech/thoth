import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Orbitron, Roboto } from "next/font/google";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

const orbitron = Orbitron({
  subsets: ["latin"],
  variable: "--font-orbitron-loaded",
  display: "swap",
});
const roboto = Roboto({
  subsets: ["latin"],
  variable: "--font-roboto-loaded",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-loaded",
  display: "swap",
});

export const metadata: Metadata = { title: "thoth" };
export const viewport: Viewport = { themeColor: "#020618", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={`${orbitron.variable} ${roboto.variable} ${jetbrains.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
