import type { MetadataRoute } from "next";

// Разрешаем индексацию только публичных страниц. Всё, что требует сессии
// (/dashboard, /agent, /campaigns и т.д.), закрыто через withTenantPage() и
// само по себе не отдаёт контент анонимному краулеру — но явный disallow
// на /api не даёт краулеру бессмысленно долбить служебные маршруты.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
    sitemap: `${process.env.PUBLIC_URL ?? "https://agent-mr.example.com"}/sitemap.xml`,
  };
}
