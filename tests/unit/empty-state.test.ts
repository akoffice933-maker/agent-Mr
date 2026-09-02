// Когда /campaigns и /analytics вправе подменить данные приглашением
// подключить кабинет.
//
// Тест существует из-за конкретной регрессии: условие было записано как
// `connected === 0` без проверки данных, и организация с sandbox-кампаниями
// (агент создаёт их без oauth-токена — run.ts, applyLocal) видела на
// /campaigns подзаголовок «1 объектов, 1 активны» и прямо под ним плашку
// «Пока не подключена ни одна площадка», а расход на /analytics пропадал
// с экрана целиком.

import { describe, expect, it } from "vitest";
import { showEmptyState } from "@/components/empty-state";

describe("showEmptyState", () => {
  it("приглашает подключить кабинет, когда нет ни площадок, ни данных", () => {
    expect(showEmptyState({ connected: 0, hasData: false })).toBe(true);
  });

  it("НЕ прячет данные sandbox-кампаний, созданных без oauth-токена", () => {
    // Ровно воспроизведённый случай: connected = 0, но кампании и расход есть.
    expect(showEmptyState({ connected: 0, hasData: true })).toBe(false);
  });

  it("не показывается при подключённой площадке — даже пока данных нет", () => {
    // Здесь пусто по другой причине (синхронизация ещё не прошла), и звать
    // подключать кабинет второй раз бессмысленно.
    expect(showEmptyState({ connected: 1, hasData: false })).toBe(false);
  });

  it("не показывается в обычном рабочем состоянии", () => {
    expect(showEmptyState({ connected: 2, hasData: true })).toBe(false);
  });
});
