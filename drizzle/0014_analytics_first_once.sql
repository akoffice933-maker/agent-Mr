-- «Первое» событие воронки должно быть ровно одно на организацию.
--
-- first_agent_message и first_approve — метрики активации: доля
-- зарегистрировавшихся, которые дошли до первого ответа агента и до
-- первого подтверждения. Считать их можно только один раз, иначе
-- активными окажутся не организации, а количество сообщений.
--
-- Проверка «нет ли уже такой записи» в коде приложения не спасает: два
-- одновременных запроса оба увидят пустую таблицу и оба вставят строку.
-- Гарантию даёт БД — частичный уникальный индекс. Вставка выполняется
-- через ON CONFLICT DO NOTHING, поэтому гонка не выбрасывает ошибку, а
-- просто не создаёт дубль.
--
-- Индекс частичный: остальные события (landing_view, cta_signup_click,
-- demo_run …) повторяются сколько угодно раз и под ограничение не
-- попадают. org_id IS NOT NULL — у анонимных событий организации нет.

-- Подчистить возможные дубли до создания уникального индекса: оставить
-- самую раннюю запись, она и есть «первая».
DELETE FROM analytics_events a
USING analytics_events b
WHERE a.event IN ('first_agent_message', 'first_approve')
  AND a.event = b.event
  AND a.org_id IS NOT NULL
  AND a.org_id = b.org_id
  AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS analytics_events_first_once_idx
  ON analytics_events (event, org_id)
  WHERE event IN ('first_agent_message', 'first_approve') AND org_id IS NOT NULL;
