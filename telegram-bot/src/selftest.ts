// Self-test for Telegram bot formatting (no token required).
import { formatAgentReply } from "./format.js";

const preview = formatAgentReply(
  "Предпросмотр изменений готов — подтвердите выполнение.",
  {
    pendingActionId: 42,
    result: {
      kind: "preview",
      title: "Пауза 2 кампаний с CTR ниже 1%",
      cost: 350,
      changes: [
        { name: "YouTube — Имиджевый ролик", before: "Активна · CTR 0,35%", after: "Статус: Пауза" },
        { name: "Товарная кампания — Фильтр", before: "Активна · CTR 0,60%", after: "Статус: Пауза" },
      ],
    },
  }
);
console.log(preview);
console.log("-----");

const blocked = formatAgentReply("Действие заблокировано политикой безопасности.", {
  result: { kind: "preview", verdict: "blocked" as never, reason: "Дневной лимит 10 000 ₽ будет превышен." },
});
console.log(blocked);

console.log("\nSELFTEST OK");
