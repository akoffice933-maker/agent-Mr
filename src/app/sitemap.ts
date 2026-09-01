import type { MetadataRoute } from "next";

// Осознанно НЕ проекция PUBLIC_PAGES из lib/public-routes.ts — там критерий
// «доступно без сессии» (там ещё /verify, /forgot, /reset — бессмысленны
// без токена в query, индексировать их незачем), здесь критерий «стоит
// показывать поисковику». Разные списки для разных вопросов, не дублирование
// одного решения.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.PUBLIC_URL ?? "https://agent-mr.example.com";
  const now = new Date();
  return [
    { url: `${base}/welcome`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/login`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/signup`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/legal/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: `${base}/legal/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
  ];
}
