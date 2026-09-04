// Гарантии для декоративных анимаций лендинга.
//
// Проверяется не «красиво ли», а три вещи, которые ломаются молча:
//
//  1. Каждая анимация лендинга перечислена в блоке prefers-reduced-motion.
//     Добавить @keyframes легко, а забыть погасить их для посетителя,
//     попросившего убрать движение, — ещё легче.
//  2. Бегущая рамка лежит ПОВЕРХ непрозрачного фона карточки. При
//     z-index:-1 её съедал bg-panel у Card, и подсветки было не видно.
//  3. Число команд в README совпадает с фактическим каталогом агента.
//     На лендинге оно берётся из uiToolCatalog(), а в README было
//     проставлено руками и разошлось (13 против 16).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { uiToolCatalog } from "@/lib/agent/tool-meta";

const root = process.cwd();
// Комментарии вырезаются: они сами содержат строки вроде «z-index:-1»,
// и проверки ловили бы пояснение вместо настоящего объявления.
const cssRaw = readFileSync(join(root, "src/app/globals.css"), "utf8");
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
const readme = readFileSync(join(root, "README.md"), "utf8");

function reducedMotionBlock(): string {
  const i = css.indexOf("@media (prefers-reduced-motion: reduce)");
  expect(i, "блок prefers-reduced-motion отсутствует в globals.css").toBeGreaterThan(-1);
  return css.slice(i);
}

describe("анимации лендинга", () => {
  it("каждая анимация гасится при prefers-reduced-motion", () => {
    const declared = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);

    // Классы, применяющие анимации, должны попасть в reduce-блок.
    const block = reducedMotionBlock();
    for (const cls of ["beam", "marquee-track", "typing-dot", "pulse-soft", "rise-in"]) {
      expect(block, `.${cls} не отключается при reduced-motion`).toContain(cls);
    }
    expect(block).toMatch(/animation:\s*none\s*!important/);
  });

  it("бегущая рамка рисуется поверх фона карточки, а не под ним", () => {
    const beam = css.match(/\.beam::before\s*\{[\s\S]*?\}/);
    expect(beam, ".beam::before не найден").not.toBeNull();
    const rule = beam![0];

    // z-index:-1 + непрозрачный bg-panel у Card = подсветки не видно.
    expect(rule).not.toMatch(/z-index:\s*-/);
    expect(rule).toMatch(/z-index:\s*1/);
    // Маска оставляет только рамку, иначе слой затемнит содержимое.
    expect(rule).toMatch(/mask-composite:\s*exclude/);
    // Слой поверх содержимого обязан пропускать клики.
    expect(rule).toMatch(/pointer-events:\s*none/);

    // isolation создало бы контекст наложения и вернуло бы дефект.
    const beamBase = css.match(/\.beam\s*\{[\s\S]*?\}/);
    expect(beamBase![0]).not.toContain("isolation");
  });

  it("лента площадок не расширяет страницу по горизонтали", () => {
    const marquee = css.match(/\.marquee\s*\{[\s\S]*?\}/);
    expect(marquee).not.toBeNull();
    // width:max-content у трека шире вьюпорта — спасает только overflow.
    expect(marquee![0]).toMatch(/overflow:\s*hidden/);
  });
});

describe("число команд агента", () => {
  it("README не расходится с фактическим каталогом", () => {
    const actual = uiToolCatalog().length;
    const mentioned = [...readme.matchAll(/(\d+)\s+команд/g)].map((m) => Number(m[1]));

    expect(mentioned.length, "в README нет упоминаний количества команд").toBeGreaterThan(0);
    for (const n of mentioned) {
      expect(n, `README обещает ${n} команд, в каталоге ${actual}`).toBe(actual);
    }
  });

  it("в каталог попадают только команды с описанием для интерфейса", () => {
    // fallback — внутренняя ветка разбора, показывать её посетителю нельзя.
    expect(uiToolCatalog().map((t) => t.name)).not.toContain("fallback");
    for (const t of uiToolCatalog()) expect(t.ui.desc.length).toBeGreaterThan(0);
  });
});
