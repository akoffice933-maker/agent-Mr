// Каждая переменная окружения, которую читает код, должна быть описана
// в .env.example.
//
// Это не косметика. Незадокументированная переменная в этом проекте
// означает конкретный риск при развёртывании:
//
//   REDIS_URL       — без него лимиты живут в памяти процесса, и при
//                     нескольких репликах общий предел умножается, а
//                     локаут по перебору пароля обходится сменой реплики;
//   YANDEX_SIMULATOR — включённый в продакшене превращает управление
//                     кампаниями в имитацию;
//   IMAGE_FETCH_ALLOWLIST — защита от SSRF;
//   AGENT_AUTH_MODE — включает аутентификацию отдельно от NODE_ENV.
//
// Человек, поднимающий стенд, читает .env.example, а не grep по исходникам.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

// Служебное: задаётся рантаймом или используется только тестами и
// локальными скриптами, в шаблоне окружения ему не место.
const NOT_FOR_ENV_EXAMPLE = new Set(["NODE_ENV", "DATABASE_TEST_URL", "PG_DATA_DIR"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

function envNamesUsedInCode(): Set<string> {
  const found = new Set<string>();
  for (const file of [...walk(join(root, "src")), ...walk(join(root, "scripts"))]) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) found.add(m[1]);
    // Вариант доступа через строковый ключ: process.env["NAME"].
    for (const m of src.matchAll(/process\.env\[["']([A-Z0-9_]+)["']\]/g)) found.add(m[1]);
  }
  return found;
}

describe(".env.example не отстаёт от кода", () => {
  const example = readFileSync(join(root, ".env.example"), "utf8");

  it("каждая читаемая переменная упомянута в шаблоне", () => {
    const used = [...envNamesUsedInCode()].filter((v) => !NOT_FOR_ENV_EXAMPLE.has(v)).sort();
    expect(used.length, "не найдено ни одной переменной — сломан разбор").toBeGreaterThan(20);

    const missing = used.filter((v) => !example.includes(v));
    expect(missing, `не описаны в .env.example: ${missing.join(", ")}`).toEqual([]);
  });

  it("опасные для продакшена переменные снабжены предупреждением", () => {
    // Мало упомянуть — из шаблона должно быть ясно, чем грозит значение.
    const line = (name: string) => {
      const i = example.indexOf(name);
      // Берём абзац вокруг упоминания: комментарий идёт выше самой строки.
      return example.slice(Math.max(0, i - 700), i + 200);
    };

    expect(line("YANDEX_SIMULATOR")).toMatch(/НИКОГДА не включайте это в продакшене/);
    expect(line("REDIS_URL")).toMatch(/реплик/i);
    expect(line("IMAGE_FETCH_ALLOWLIST")).toMatch(/SSRF/);
  });

  it("обязательные переменные присутствуют без комментария", () => {
    // DATABASE_URL и ENCRYPTION_KEY нужны всегда: закомментированными их
    // оставлять нельзя, иначе копия шаблона не заводится.
    for (const req of ["DATABASE_URL=", "ENCRYPTION_KEY="]) {
      const active = example.split("\n").some((l) => l.trimStart().startsWith(req));
      expect(active, `${req} должна быть раскомментирована в .env.example`).toBe(true);
    }
  });
});
