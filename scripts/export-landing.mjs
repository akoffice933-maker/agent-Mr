// Экспорт публичных страниц в статику для GitHub Pages (demo/).
//
// Почему не `output: "export"`: приложение целиком экспортировать нельзя — в
// нём есть API-роуты, прокси и серверные страницы с БД. Публичная же часть
// (лендинг + юридические документы) уже собирается как статика (○ в выводе
// next build), поэтому её достаточно снять с работающего прод-сервера вместе
// с ассетами из /_next и переписать пути под подкаталог GitHub Pages.
//
// Запуск:
//   npx next build && npx next start -p 3200 &
//   node scripts/export-landing.mjs [--base /agent-Mr] [--out demo]
//
// Результат детерминирован и коммитится в репозиторий: workflow
// .github/workflows/github-pages.yml публикует каталог demo/ как есть.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ORIGIN = argOf("--origin", "http://127.0.0.1:3200");
// GitHub Pages проекта отдаётся из подкаталога /<repo>, поэтому все
// абсолютные ссылки на /_next/... и на страницы надо префиксовать.
const BASE = argOf("--base", "/agent-Mr").replace(/\/$/, "");
const OUT = argOf("--out", "demo");

// Страницы, которые публикуем. Только те, что не требуют сессии и не читают
// tenant-данные — см. lib/public-routes.ts.
const PAGES = [
  { route: "/welcome", file: "index.html" },
  { route: "/legal/privacy", file: "legal/privacy/index.html" },
  { route: "/legal/terms", file: "legal/terms/index.html" },
];

const assets = new Set();

/** Собирает пути к /_next/... из HTML, чтобы скачать их следом. */
function collectAssets(html) {
  const re = /["'(](\/_next\/[^"')\s]+)["')\s]/g;
  let m;
  while ((m = re.exec(html)) !== null) assets.add(m[1]);
}

/**
 * Переписывает абсолютные пути под подкаталог Pages.
 *
 * Отдельно чиним ссылки в закрытую часть продукта: на статическом зеркале
 * никакого /login и /signup нет, и вести туда посетителя в никуда — хуже, чем
 * честно указать на исходный репозиторий.
 */
function rewrite(html) {
  let out = html
    .replaceAll('"/_next/', `"${BASE}/_next/`)
    .replaceAll("'/_next/", `'${BASE}/_next/`)
    .replaceAll("(/_next/", `(${BASE}/_next/`)
    .replaceAll('"/legal/', `"${BASE}/legal/`)
    .replaceAll('href="/welcome"', `href="${BASE}/"`);

  // Ссылки на рабочую часть → на репозиторий (демо статическое, входа нет).
  const REPO = "https://github.com/akoffice933-maker/agent-Mr";
  for (const p of ["/login", "/signup", "/dashboard", "/agent", "/billing"]) {
    out = out.replaceAll(`href="${p}"`, `href="${REPO}" target="_blank" rel="noopener"`);
  }

  // Баннер: посетитель должен понимать, что это витрина, а не рабочий стенд.
  const banner = `<div style="background:#c6f052;color:#171b08;font:600 12px/1.5 system-ui,sans-serif;padding:8px 16px;text-align:center">
Статическая витрина лендинга Unified AI Ads Agent. Рабочее приложение (вход, дашборд, агент) требует сервера и базы —
<a href="${REPO}" style="color:#171b08;text-decoration:underline">исходный код на GitHub</a>.
</div>`;
  out = out.replace(/(<body[^>]*>)/, `$1${banner}`);
  return out;
}

async function save(path, data) {
  const full = join(OUT, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
}

async function main() {
  await rm(OUT, { recursive: true, force: true });

  for (const p of PAGES) {
    const res = await fetch(ORIGIN + p.route);
    if (!res.ok) throw new Error(`${p.route} → HTTP ${res.status}`);
    const html = await res.text();
    collectAssets(html);
    await save(p.file, rewrite(html));
    console.log(`page  ${p.route} → ${p.file} (${html.length} B)`);
  }

  for (const a of assets) {
    const res = await fetch(ORIGIN + a);
    if (!res.ok) {
      console.warn(`skip  ${a} → HTTP ${res.status}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // CSS тоже содержит /_next/ (шрифты) — правим и его.
    const body = a.endsWith(".css") ? Buffer.from(rewrite(buf.toString("utf8"))) : buf;
    await save(a.replace(/^\//, ""), body);
  }
  console.log(`assets ${assets.size}`);

  // .nojekyll: без него Pages игнорирует каталоги, начинающиеся с подчёркивания
  // (_next) — самая частая причина «стили не подхватились».
  await save(".nojekyll", "");
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
