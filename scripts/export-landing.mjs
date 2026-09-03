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
// Каталог demo/ — артефакт сборки, а НЕ содержимое репозитория: он в
// .gitignore и его не нужно коммитить. Workflow
// .github/workflows/github-pages.yml на каждый push в main пересобирает
// приложение, заново снимает витрину этим скриптом, проверяет результат
// шагом «Verify export» и только потом публикует. Единственный источник
// истины — src/app/welcome/page.tsx и остальные страницы приложения.

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
  // Внутри RSC-payload пути экранированы: \"/_next/chunk.js\". Если не
  // исключить обратный слэш из класса символов, он попадает в имя и на диск
  // ложится дубль «chunk.js\» — мёртвый файл, который Pages никому не отдаст.
  const re = /["'(](\/_next\/[^"')\s\\]+)["')\s\\]/g;
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
  // Два прохода, и оба обязательны.
  //
  // 1) Обычная HTML-разметка. Регулярка, а не точное совпадение: у карточки
  //    Pro ссылка вида href="/signup?plan=pro", и replaceAll по
  //    `href="/signup"` её не ловил — кнопка тарифа вела в 404.
  const APP = "(login|signup|dashboard|agent|billing)";
  out = out.replace(
    new RegExp(`href="/${APP}(\\?[^"]*)?"`, "g"),
    `href="${REPO}" target="_blank" rel="noopener"`
  );

  // 2) RSC-payload в <script>: там та же ссылка сериализована как
  //    \"href\":\"/signup?plan=pro\". Пропустить этот проход — значит
  //    починить ссылку только до гидратации: React поднимет payload и
  //    вернёт на кнопку исходный путь, ведущий в никуда. Заменяем ЗНАЧЕНИЕ,
  //    сохраняя структуру JSON, — иначе payload перестанет разбираться.
  out = out.replace(
    new RegExp(`\\\\"href\\\\":\\\\"/${APP}(\\?[^"\\\\]*)?\\\\"`, "g"),
    `\\"href\\":\\"${REPO}\\"`
  );

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

  // 404.html: на Pages нет сервера, который увёл бы /login или опечатку в
  // приложение, — без своей страницы посетитель видит стандартную заглушку
  // GitHub и не понимает, куда попал. Возвращаем его на витрину.
  const REPO = "https://github.com/akoffice933-maker/agent-Mr";
  await save(
    "404.html",
    `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Страница не найдена — Unified AI Ads Agent</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0d1013;color:#e9ede6;font:400 15px/1.6 system-ui,-apple-system,sans-serif;padding:24px}
  .b{max-width:460px;text-align:center}
  h1{font-size:22px;margin:0 0 12px}
  p{color:#8c97a6;font-size:14px;margin:0 0 20px}
  a{display:inline-block;margin:0 6px;padding:10px 18px;border-radius:10px;
    font-size:13px;font-weight:700;text-decoration:none}
  .p{background:#c6f052;color:#171b08}
  .s{border:1px solid #262e38;color:#e9ede6}
</style></head><body><div class="b">
<h1>Здесь только витрина</h1>
<p>Это статическая копия лендинга на GitHub Pages: рабочее приложение — вход, дашборд, агент —
требует сервера и базы данных, поэтому по этому адресу их нет.</p>
<a class="p" href="${BASE}/">На главную</a><a class="s" href="${REPO}">Исходный код</a>
</div></body></html>`
  );
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
