// Переписывание ссылок и путей при экспорте витрины на GitHub Pages.
//
// Экспортёр — единственное, что отделяет рабочие страницы от статической
// копии, и его ошибки видны сразу всем посетителям, а не разработчику. Три
// случая ниже — не гипотетические, все три были на живом сайте:
//
//   1. href="/signup?plan=pro" на карточке Pro не переписывался (замена шла
//      по точному совпадению href="/signup"), и единственная кнопка тарифа
//      вела в 404;
//   2. в RSC-payload пути экранированы (\"/_next/chunk.js\"), обратный слэш
//      попадал в имя файла, и на диск ложились мёртвые дубли «chunk.js\»;
//   3. без /404.html любая опечатка в адресе показывала стандартную заглушку
//      GitHub вместо объяснения, куда человек попал.
//
// Тест держит те же регулярные выражения, что и scripts/export-landing.mjs.
// Дублирование намеренное: скрипт — ESM для Node без экспортов, тянуть его в
// vitest дороже, чем сторожить контракт здесь.

import { describe, expect, it } from "vitest";

const BASE = "/agent-Mr";
const REPO = "https://github.com/akoffice933-maker/agent-Mr";

/** Копия collectAssets() из scripts/export-landing.mjs. */
function collectAssets(html: string): string[] {
  const re = /["'(](\/_next\/[^"')\s\\]+)["')\s\\]/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.add(m[1]);
  return [...out];
}

const APP = "(login|signup|dashboard|agent|billing)";

/** Копия обоих проходов из scripts/export-landing.mjs. */
function rewriteAppLinks(html: string): string {
  return html
    // 1) обычная разметка
    .replace(new RegExp(`href="/${APP}(\\?[^"]*)?"`, "g"), `href="${REPO}" target="_blank" rel="noopener"`)
    // 2) RSC-payload: \"href\":\"/signup?plan=pro\"
    .replace(new RegExp(`\\\\"href\\\\":\\\\"/${APP}(\\?[^"\\\\]*)?\\\\"`, "g"), `\\"href\\":\\"${REPO}\\"`);
}

describe("export-landing", () => {
  it("переписывает ссылки в закрытую часть, включая query-строку", () => {
    const html = [
      '<a href="/login">Войти</a>',
      '<a href="/signup">Начать</a>',
      // Карточка Pro — тот самый случай, который раньше оставался битым.
      '<a href="/signup?plan=pro">Выбрать Pro</a>',
      '<a href="/dashboard">Дашборд</a>',
    ].join("");
    const out = rewriteAppLinks(html);

    expect(out).not.toContain('href="/login"');
    expect(out).not.toContain('href="/signup"');
    expect(out).not.toContain('href="/signup?plan=pro"');
    expect(out).not.toContain('href="/dashboard"');
    expect(out.match(new RegExp(REPO, "g"))?.length).toBe(4);
  });

  it("переписывает экранированные ссылки из RSC-payload", () => {
    // Внутри payload разметка сериализована со слэшами.
    const payload = '{\\"href\\":\\"/signup?plan=pro\\",\\"children\\":\\"Pro\\"}';
    expect(rewriteAppLinks(payload)).toContain(REPO);
  });

  it("не трогает публичные ссылки", () => {
    const html = `<a href="${BASE}/legal/privacy">Политика</a><a href="#pricing">Тарифы</a>`;
    expect(rewriteAppLinks(html)).toBe(html);
  });

  it("собирает пути к ассетам без обратного слэша в имени", () => {
    const html = [
      '<link href="/_next/static/chunks/main.css">',
      // Экранированный вариант из RSC — слэш не должен попасть в имя файла.
      '{\\"src\\":\\"/_next/static/chunks/app.js\\"}',
      "url(/_next/static/media/font.woff2)",
    ].join("");
    const assets = collectAssets(html);

    expect(assets).toContain("/_next/static/chunks/main.css");
    expect(assets).toContain("/_next/static/chunks/app.js");
    expect(assets).toContain("/_next/static/media/font.woff2");
    for (const a of assets) expect(a).not.toContain("\\");
  });
});
