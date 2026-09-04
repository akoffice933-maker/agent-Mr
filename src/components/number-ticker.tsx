"use client";

// Счётчик, добегающий до значения при попадании в зону видимости.
//
// Три требования, которые определили реализацию:
//
//  1. Витрина — статический экспорт, и страница обязана быть осмысленной
//     без JS. Поэтому итоговое число выводится в разметку сразу (SSR), а
//     скрипт лишь переигрывает его снизу вверх. Если JS отключён или чанк
//     не догрузился, посетитель видит финальную цифру, а не ноль.
//  2. Анимация стартует не при монтировании, а когда блок реально виден:
//     цифры в середине страницы иначе отсчитали бы себя до скролла.
//  3. prefers-reduced-motion уважается: значение проставляется сразу.
//
// Подписка на medium-запрос сделана через useSyncExternalStore — в этом
// репозитории setState внутри useEffect запрещён линтером.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

function subscribeReducedMotion(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false, // на сервере считаем, что анимация разрешена
  );
}

export function NumberTicker({
  value,
  duration = 1100,
  className = "",
}: {
  value: number;
  duration?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  // null = «ещё не анимировали», показываем финальное значение из SSR.
  const [shown, setShown] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || reduced) return;
    // IntersectionObserver есть во всех целевых браузерах; при его
    // отсутствии просто оставляем статичное число.
    if (typeof IntersectionObserver === "undefined") return;

    let raf = 0;
    let done = false;

    const io = new IntersectionObserver(
      (entries) => {
        if (done || !entries.some((e) => e.isIntersecting)) return;
        done = true;
        io.disconnect();

        const start = performance.now();
        const tick = (now: number) => {
          const p = Math.min(1, (now - start) / duration);
          // easeOutCubic: быстрый разгон, мягкая остановка.
          const eased = 1 - Math.pow(1 - p, 3);
          setShown(Math.round(value * eased));
          if (p < 1) raf = requestAnimationFrame(tick);
          else setShown(null); // вернуться к SSR-значению
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );

    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value, duration, reduced]);

  return (
    <span ref={ref} className={`num ${className}`}>
      {shown ?? value}
    </span>
  );
}
