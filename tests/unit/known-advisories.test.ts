// Защита цепочки поставок: пины экшенов, cooldown Dependabot и
// обоснование принятой уязвимости.
//
// Всё это — конфигурация, которую легко «починить обратно» одной строкой,
// и ошибка при этом ничего не сломает в тестах, пока не станет поздно:
//
//   * `uses: action@v4` можно переписать на месте владельца экшена —
//     именно так угоняли trivy-action и kics-github-action. Пин на
//     40-символьный SHA делает подмену невозможной;
//   * без cooldown Dependabot предложит пакет, опубликованный час назад,
//     а типовая атака — угон учётки мейнтейнера и релиз с вредоносным
//     postinstall;
//   * CVE-2026-71429 в stream-json оставлена без обновления сознательно.
//     Обоснование держится на трёх фактах, каждый из которых может
//     измениться, и тогда решение нужно пересмотреть, а не унаследовать.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/github-pages.yml"];

describe("GitHub Actions закреплены по SHA", () => {
  it("ни один шаг не ссылается на изменяемый тег или ветку", () => {
    const bad: string[] = [];
    for (const wf of WORKFLOWS) {
      for (const line of read(wf).split("\n")) {
        const m = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
        if (!m) continue;
        const ref = m[1].split("@")[1] ?? "";
        // Допустим только полный 40-символьный хеш коммита.
        if (!/^[0-9a-f]{40}$/.test(ref)) bad.push(`${wf}: ${m[1]}`);
      }
    }
    expect(bad, `не закреплены по SHA:\n${bad.join("\n")}`).toEqual([]);
  });

  it("рядом с хешем сохранена версия — иначе Dependabot не обновит пин", () => {
    for (const wf of WORKFLOWS) {
      for (const line of read(wf).split("\n")) {
        if (!/uses:\s*\S+@[0-9a-f]{40}/.test(line)) continue;
        expect(line, `нет комментария с версией: ${line.trim()}`).toMatch(/#\s*v?\d/);
      }
    }
  });
});

describe("Dependabot выдерживает паузу перед обновлением", () => {
  it("cooldown задан для КАЖДОЙ экосистемы", () => {
    const cfg = read(".github/dependabot.yml");
    // Блоков updates ровно столько же, сколько cooldown.
    const ecosystems = [...cfg.matchAll(/^\s*-\s*package-ecosystem:/gm)].length;
    const cooldowns = [...cfg.matchAll(/^\s*cooldown:/gm)].length;

    expect(ecosystems).toBeGreaterThan(0);
    expect(cooldowns, `экосистем ${ecosystems}, cooldown-блоков ${cooldowns}`).toBe(ecosystems);
    expect([...cfg.matchAll(/default-days:\s*(\d+)/g)].map((m) => Number(m[1]))).toSatisfy(
      (days: number[]) => days.length === ecosystems && days.every((d) => d >= 7)
    );
  });
});

describe("образ сообщает оркестратору о своём состоянии", () => {
  it("в Dockerfile есть HEALTHCHECK, опирающийся на /api/health", () => {
    const df = read("Dockerfile");
    expect(df).toMatch(/^HEALTHCHECK/m);
    expect(df).toContain("/api/health");
    // Проверка обязана падать при недоступной БД: роут отдаёт 503,
    // поэтому код выхода считается из r.ok.
    expect(df).toMatch(/r\.ok\s*\?\s*0\s*:\s*1/);
  });
});

describe("принятая уязвимость stream-json остаётся обоснованной", () => {
  const lock = JSON.parse(read("package-lock.json")) as {
    packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
  };

  it("обоснование записано в SECURITY.md", () => {
    const sec = read("SECURITY.md");
    expect(sec).toContain("CVE-2026-71429");
    expect(sec).toContain("stream-json");
  });

  it("наш код по-прежнему не импортирует stream-json напрямую", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx|mjs)$/.test(n)) out.push(p);
      }
      return out;
    };
    const hits = walk(join(root, "src")).filter((f) => readFileSync(f, "utf8").includes("stream-json"));
    expect(hits, "появился прямой импорт — уязвимые фильтры стали достижимы").toEqual([]);
  });

  it("stream-json тянется только транзитивно через google-ads-api", () => {
    const owners = Object.entries(lock.packages)
      .filter(([, v]) => v.dependencies && "stream-json" in v.dependencies)
      .map(([k]) => k);
    expect(owners, `неожиданные потребители: ${owners.join(", ")}`).toEqual([
      "node_modules/google-ads-api",
    ]);
  });
});
