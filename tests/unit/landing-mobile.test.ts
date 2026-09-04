// Лендинг обязан помещаться в 375px (ТЗ: мобильная адаптивность).
//
// Дефект, ради которого написан тест: верхняя панель складывалась из
// логотипа «Unified AI Ads Agent» (~204px), ссылки «Войти» и кнопки
// «Начать бесплатно» (~143px). В сумме ~463px при доступных 375 — и,
// поскольку ни один элемент не мог сжаться, строка распирала страницу
// и появлялась горизонтальная прокрутка на всей странице.
//
// Проверяется не «красиво ли», а структурные признаки, из-за которых
// flex-строка перестаёт помещаться:
//   * flex-элемент с длинным текстом без min-w-0 не сжимается ниже
//     содержимого — это и есть механизм переполнения;
//   * фиксированные элементы (иконка, кнопка) должны нести shrink-0,
//     иначе схлопываются в кашу вместо переноса;
//   * длинные строки должны иметь короткий вариант для узкого экрана.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(process.cwd(), "src/app/welcome/page.tsx"), "utf8");

/** Грубая оценка ширины строки: кегль × коэффициент глифа. */
function textWidth(text: string, fontPx: number, bold = true): number {
  return text.length * fontPx * (bold ? 0.6 : 0.55);
}

describe("верхняя панель помещается на узком экране", () => {
  const header = page.slice(page.indexOf("h-14 w-full max-w-"), page.indexOf("</header>"));

  it("длинное название скрыто на узком экране, есть короткий вариант", () => {
    // Полное имя вместе с иконкой и зазором занимает ~204px и не
    // оставляет места кнопке; короткое — вдвое меньше.
    const full = textWidth("Unified AI Ads Agent", 14) + 28 + 8;
    const short = textWidth("Agent Mr", 14) + 28 + 8;
    expect(full).toBeGreaterThan(200);
    expect(short).toBeLessThan(full / 1.5);
    expect(header).toContain("Agent Mr");
    expect(header).toMatch(/min-\[400px\]:hidden/);
    expect(header).toMatch(/hidden min-\[400px\]:inline/);
  });

  it("контейнер логотипа может сжиматься (min-w-0), иконка — нет (shrink-0)", () => {
    // Без min-w-0 flex-потомок не уменьшается ниже своего содержимого.
    expect(header).toMatch(/className="flex min-w-0 items-center gap-2"/);
    expect(header).toMatch(/h-7 w-7 shrink-0/);
    expect(header).toMatch(/truncate/);
  });

  it("кнопка призыва не сжимается и имеет короткий текст", () => {
    expect(header).toMatch(/whitespace-nowrap/);
    expect(header).toMatch(/sm:hidden">Начать</);
    expect(header).toMatch(/hidden sm:inline">Начать бесплатно</);
  });

  it("правая группа не сжимается, «Войти» скрыт на самых узких", () => {
    expect(header).toMatch(/ml-auto flex shrink-0 items-center/);
    expect(header).toMatch(/hidden[^"]*min-\[420px\]:block/);
  });

  it("итоговая ширина шапки укладывается в 375px", () => {
    const padding = 16 * 2; // px-4
    const gap = 16 + 8;
    const icon = 28;
    const logo = textWidth("Agent Mr", 14); // короткий вариант
    const cta = textWidth("Начать", 12) + 14 * 2; // px-3.5
    const total = padding + gap + icon + logo + cta;

    expect(total, `шапке нужно ${Math.round(total)}px`).toBeLessThan(375);
  });
});

describe("прочие узкие места", () => {
  it("бейдж площадок переносится, а не распирает строку", () => {
    const i = page.indexOf("Google Ads · Яндекс.Директ · Авито");
    expect(i).toBeGreaterThan(-1);
    const badge = page.slice(Math.max(0, i - 400), i);
    // Строка с «·» не переносится сама — нужен flex-wrap.
    expect(badge).toMatch(/flex-wrap/);
    expect(badge).toMatch(/max-w-full/);
  });

  it("сетки строятся mobile-first: одна колонка по умолчанию", () => {
    // grid-cols-N без префикса означает N колонок уже на 375px.
    const bare = [...page.matchAll(/className="[^"]*\bgrid\b[^"]*"/g)]
      .map((m) => m[0])
      .filter((c) => /(?<![a-z:])grid-cols-[2-9]/.test(c));
    expect(bare, `сетки без брейкпоинта: ${bare.join(" | ")}`).toEqual([]);
  });

  it("лента площадок обрезается по краю, а не растягивает страницу", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const marquee = css.match(/\.marquee\s*\{[\s\S]*?\}/);
    expect(marquee).not.toBeNull();
    expect(marquee![0]).toMatch(/overflow:\s*hidden/);
  });
});
