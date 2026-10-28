-- ============================================================================
--  BUKEAME — Migración 35: add-on RECEPCIONISTA IA (llamadas con Retell)
--  Idempotente. Correr: sudo -u postgres psql -d bukeame -f database/35-schema-recepcionista-ia.sql
-- ----------------------------------------------------------------------------
--  · addon_catalog: 'ai_receptionist' a $39/mes (150 minutos incluidos).
--  · voice_lines : la línea de cada negocio (número de Retell) + cómo quiere que
--                  conteste (voz, saludo, preguntas frecuentes, apodos, modo).
--  · voice_calls : cada llamada (duración, costo, resultado, resumen, grabación).
--                  De aquí salen los minutos usados del periodo pagado del add-on.
-- ============================================================================

-- ALTER TYPE ADD VALUE NO puede ir dentro de una transacción (BEGIN/COMMIT).
ALTER TYPE addon_code ADD VALUE IF NOT EXISTS 'ai_receptionist';

BEGIN;

INSERT INTO addon_catalog (code, name, price_cents, billing, description) VALUES
('ai_receptionist', 'Recepcionista IA', 3900, 'monthly',
 'Contesta las llamadas que no coges, da precios y reserva citas. 150 minutos al mes.')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS voice_lines (
  business_id      uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  phone_number     text UNIQUE,                    -- E.164 del número de Retell; NULL = sin línea
  line_status      text NOT NULL DEFAULT 'none'
                   CHECK (line_status IN ('none','buying','active','paused')),
  paused_at        timestamptz,                    -- cuándo venció el add-on (se suelta a los 30 días)
  voice_id         text,                           -- NULL = la voz de la plantilla
  greeting         text,                           -- NULL = "Gracias por llamar a <negocio>."
  faq              jsonb NOT NULL DEFAULT '[]',    -- [{q, a}]
  aliases          text,                           -- "fade = Corte; recorte = Corte"
  mode             text NOT NULL DEFAULT 'book' CHECK (mode IN ('book','messages')),
  transfer_number  text,                           -- E.164 opcional para pasar la llamada a una persona
  minutes_included integer NOT NULL DEFAULT 150,
  warned           text,                           -- 'AAAA-MM:80' / 'AAAA-MM:100' (aviso de minutos ya enviado)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS voice_calls (
  call_id              text PRIMARY KEY,           -- id de Retell
  business_id          uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  from_number          text,
  to_number            text,
  started_at           timestamptz NOT NULL DEFAULT now(),
  ended_at             timestamptz,
  duration_sec         integer,
  cost_cents           numeric(10,2),              -- lo que cobró Retell (centavos)
  outcome              text NOT NULL DEFAULT 'none'
                       CHECK (outcome IN ('none','booked','message','transferred')),
  appointment_code     text,
  summary              text,
  recording_url        text,
  disconnection_reason text,
  limited              boolean NOT NULL DEFAULT false,  -- minutos agotados: solo tomó mensajes
  bookings             integer NOT NULL DEFAULT 0,      -- citas hechas en esta llamada (tope 2)
  messages             integer NOT NULL DEFAULT 0       -- mensajes dejados en esta llamada (tope 2)
);
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS bookings integer NOT NULL DEFAULT 0;
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS messages integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_voice_calls_biz ON voice_calls(business_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_calls_abiertas ON voice_calls(started_at) WHERE duration_sec IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON voice_lines TO bukeame_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON voice_calls TO bukeame_user;
GRANT SELECT ON addon_catalog TO bukeame_user;

COMMIT;
