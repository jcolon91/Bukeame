-- ============================================================================
--  Bukéame — Tiempo para tomar un turno de la lista de espera (34). Idempotente.
--  Cuando se libera un turno, el primero de la fila que le sirva tiene estos minutos
--  para tomarlo por el enlace del WhatsApp; si no, pasa al siguiente. El negocio lo
--  cambia en "Lista de espera". Antes era fijo en 30; el default nuevo es 15.
--  Correr: sudo -u postgres psql -d bukeame -f database/34-schema-waitlist-minutes.sql
-- ============================================================================
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS waitlist_offer_minutes smallint NOT NULL DEFAULT 15;

DO $$ BEGIN
  ALTER TABLE businesses ADD CONSTRAINT businesses_waitlist_offer_minutes_chk
    CHECK (waitlist_offer_minutes BETWEEN 5 AND 120);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON businesses TO bukeame_user;
