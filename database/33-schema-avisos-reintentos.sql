-- ============================================================================
--  Bukéame — Reintentos de avisos (33). Idempotente.
--  Un WhatsApp/email que falla por una caída temporal (Evolution o Resend fuera,
--  5xx, red) se reintenta a los 5 y a los 30 minutos antes de quedar 'failed'.
--  'skipped' = no se mandó a propósito (la cita ya pasó o se canceló mientras
--  esperaba). Hasta correr esto, server.js funciona como antes, sin reintentos.
--  Correr: sudo -u postgres psql -d bukeame -f database/33-schema-avisos-reintentos.sql
-- ============================================================================
ALTER TYPE msg_status ADD VALUE IF NOT EXISTS 'skipped';

ALTER TABLE message_log ADD COLUMN IF NOT EXISTS attempts        smallint NOT NULL DEFAULT 0;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

-- La cola (status='queued') se lee cada 20 s; este índice parcial la mantiene rápida.
CREATE INDEX IF NOT EXISTS idx_msg_queue ON message_log (created_at) WHERE status = 'queued';

GRANT SELECT, INSERT, UPDATE, DELETE ON message_log TO bukeame_user;
