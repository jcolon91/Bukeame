-- ============================================================================
--  BUKEAME — Migración 39: add-on DIFUSIONES por WhatsApp
--  Idempotente. Correr: sudo -u postgres psql -d bukeame -f database/39-schema-difusiones.sql
-- ----------------------------------------------------------------------------
--  El negocio prepara un aviso (los espacios de la semana, una oferta, una noticia) y
--  le llega por WhatsApp a sus clientes atendidos que ACEPTARON recibir avisos. Sale
--  del número de Bukéame, despacio y con topes, para no poner en riesgo los
--  recordatorios de citas de todos los negocios.
--  · addon_catalog       : 'broadcasts' a $4.99/mes (los mensajes del mes los fija el código).
--  · clients             : cuándo aceptó los avisos por WhatsApp, por dónde, y su baja.
--  · broadcasts          : cada difusión del negocio.
--  · broadcast_recipients: a quién le toca (el id es el token del enlace de baja).
-- ============================================================================

-- ALTER TYPE ADD VALUE NO puede ir dentro de una transacción (BEGIN/COMMIT).
ALTER TYPE addon_code ADD VALUE IF NOT EXISTS 'broadcasts';

BEGIN;

INSERT INTO addon_catalog (code, name, price_cents, billing, description) VALUES
('broadcasts', 'Difusiones por WhatsApp', 499, 'monthly',
 'Avísales por WhatsApp a tus clientes que aceptaron recibir avisos: los espacios de la semana, una oferta o una noticia. Trae 500 mensajes al mes.')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS wa_promo_opt_in_at  timestamptz;   -- aceptó avisos por WhatsApp
ALTER TABLE clients ADD COLUMN IF NOT EXISTS wa_promo_source     text;          -- 'reserva' (marcó la casilla) | 'negocio' (lo marcó el negocio)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS wa_promo_opt_out_at timestamptz;   -- se dio de baja con el enlace

CREATE TABLE IF NOT EXISTS broadcasts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  body            text NOT NULL,                          -- el texto del negocio, tal cual
  status          text NOT NULL DEFAULT 'queued',            -- el CHECK va más abajo
  audience_count  integer NOT NULL DEFAULT 0,             -- a cuántos se puso en la fila
  capped          integer NOT NULL DEFAULT 0,             -- los que no cupieron en los mensajes del mes
  sent_count      integer NOT NULL DEFAULT 0,
  failed_count    integer NOT NULL DEFAULT 0,
  stop_reason     text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_broadcasts_biz ON broadcasts(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcasts_cola ON broadcasts(status, created_at) WHERE status IN ('queued','sending');

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- token del enlace de baja
  broadcast_id  uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  phone         text NOT NULL,
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','sending','sent','failed','skipped')),
  attempts      smallint NOT NULL DEFAULT 0,
  error         text,
  sent_at       timestamptz,
  opted_out_at  timestamptz,                                  -- se dio de baja desde este mensaje
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (broadcast_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_bcast_rcpt_cola ON broadcast_recipients(broadcast_id, status);
CREATE INDEX IF NOT EXISTS idx_bcast_rcpt_mes ON broadcast_recipients(business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bcast_rcpt_enviados ON broadcast_recipients(sent_at) WHERE status = 'sent';

-- Frenos que salieron de la revisión (5-nov). Van como ALTER para que la migración se
-- pueda correr otra vez sobre una base que ya tenía las tablas.
--  · La PRIMERA difusión de cada negocio la aprueba Wifnix ('pending_review'), y un
--    negocio con muchas bajas o números malos queda en pausa hasta que Wifnix lo revise.
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('pending_review','queued','sending','sent','stopped','rejected'));
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS queued_at    timestamptz;   -- desde cuándo puede salir (crear o aprobar); vence a las 24 h
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;   -- para turnarse entre negocios
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS review_note  text;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS reviewed_by  uuid REFERENCES users(id);
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS reviewed_at  timestamptz;
--  · Reintentos espaciados y rescate de lo que se quedó "enviando" si el proceso se cayó.
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS claimed_at      timestamptz;
--  · Tope por teléfono entre todos los negocios (el número que envía es uno solo).
CREATE INDEX IF NOT EXISTS idx_bcast_rcpt_tel ON broadcast_recipients(phone, sent_at) WHERE status = 'sent';
--  · Por negocio: su primera difusión aprobada, y la pausa por bajas o números malos.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS broadcasts_approved_at   timestamptz;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS broadcasts_blocked_at    timestamptz;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS broadcasts_block_reason  text;

GRANT SELECT, INSERT, UPDATE, DELETE ON broadcasts, broadcast_recipients TO bukeame_user;
GRANT SELECT ON addon_catalog TO bukeame_user;

COMMIT;
