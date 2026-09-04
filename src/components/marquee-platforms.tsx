// Бесшовная лента площадок и охваченных ими сущностей.
//
// Серверный компонент: движение целиком на CSS (.marquee / .marquee-track
// в globals.css), поэтому на витрину не добавляется ни килобайта JS.
//
// Набор дублируется в разметке дважды — трек сдвигается ровно на -50%,
// и вторая копия занимает место первой без рывка. aria-hidden на копии,
// чтобы скринридер не прочитал список повторно.

import { platformDot } from "@/components/ui";

const ITEMS: { p: "google" | "yandex" | "avito"; label: string; note: string }[] = [
  { p: "google", label: "Google Ads", note: "кампании, ставки, минус-фразы" },
  { p: "yandex", label: "Яндекс.Директ", note: "кампании, ставки, Метрика" },
  { p: "avito", label: "Авито", note: "объявления, продвижение, чаты" },
];

function PlatformItem({ p, label, note }: { p: "google" | "yandex" | "avito"; label: string; note: string }) {
  return (
    <span className="mx-3 inline-flex shrink-0 items-center gap-2.5 rounded-xl border border-line bg-panel2 px-4 py-2.5">
      <span className={`h-2 w-2 shrink-0 rounded-full ${platformDot(p)}`} />
      <span className="text-sm font-semibold text-snow">{label}</span>
      <span className="hidden text-xs text-fog sm:inline">{note}</span>
    </span>
  );
}

export function MarqueePlatforms() {
  const set = (hidden: boolean) => (
    <div className="flex" aria-hidden={hidden || undefined}>
      {ITEMS.map((it) => (
        <PlatformItem key={`${hidden ? "b" : "a"}-${it.p}`} {...it} />
      ))}
    </div>
  );

  return (
    <div className="marquee py-1">
      <div className="marquee-track">
        {set(false)}
        {set(true)}
      </div>
    </div>
  );
}
