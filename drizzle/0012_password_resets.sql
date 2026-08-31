-- 0012: сброс пароля (ТЗ §9.2, последний пункт).
--
-- Отдельная таблица, а не переиспользование email_verifications: у токенов
-- разное назначение и разный TTL (подтверждение адреса живёт сутки, сброс
-- пароля — час), а главное — разные последствия компрометации. Смешивать их
-- в одной таблице значит однажды перепутать назначение токена в запросе.
--
-- Хранится только ХЕШ токена: утечка дампа или строки лога не должна давать
-- рабочую ссылку на смену пароля (та же дисциплина, что в email_verifications
-- и org_invites).
CREATE TABLE IF NOT EXISTS password_resets (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  -- Кому реально ушло письмо: адрес мог смениться после выпуска токена.
  sent_to text NOT NULL,
  -- Диагностика злоупотреблений (rate limit живёт в прокси, это след постфактум).
  requested_ip text
);

CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id);
-- Уборка просроченных: индекс по времени жизни, а не полный скан таблицы.
CREATE INDEX IF NOT EXISTS password_resets_expires_idx ON password_resets(expires_at)
  WHERE consumed_at IS NULL;
