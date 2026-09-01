import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Manrope, Space_Grotesk } from "next/font/google";
import { Chrome } from "@/components/chrome";
import "./globals.css";

const manrope = Manrope({ subsets: ["latin", "cyrillic"], variable: "--font-manrope" });
const grotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-grotesk" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.PUBLIC_URL ?? "https://agent-mr.example.com"),
  title: "Unified AI Ads Agent — Google Ads · Яндекс.Директ · Авито",
  description:
    "Единый AI-агент для управления рекламой на трёх платформах: естественный язык, safety-слой, сквозная аналитика и audit-log.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" className={`${manrope.variable} ${grotesk.variable}`}>
      <body className="antialiased">
        <Chrome>{children}</Chrome>
      </body>
    </html>
  );
}
