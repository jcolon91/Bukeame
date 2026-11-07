-- ============================================================================
--  41 · PAGO A PLAZOS: Klarna, Affirm y Acima
-- ----------------------------------------------------------------------------
--  · plazos_config: qué ofrece cada negocio y por dónde (su Stripe o su cuenta directa).
--    Klarna y Affirm por Stripe salen solos en el checkout del negocio cuando los activa
--    en SU Stripe; aquí se guarda lo que respondió Stripe (stripe_caps) para decirlo en el
--    panel y en la página. Acima va con el enlace de solicitud que Acima le da al negocio.
--    Nada de esto es secreto: Bukéame no guarda llaves de ninguno de los tres.
--  · products.acima_ok: el negocio marca qué artículos se pueden arrendar con Acima
--    (Acima no arrienda servicios, ropa, gift cards ni consumibles).
--  · cobro_enlaces: cobros por enlace desde el panel (el servicio completo, con tarjeta,
--    Klarna o Affirm en la página de Stripe del negocio). Se marcan pagados por el webhook.
--  · payment_method: 'klarna', 'affirm' y 'acima' para anotar cómo pagó el cliente.
--
--  Va DESPUÉS de la 38 (membresías): un cobro de solo propina usa el CHECK de payments
--  que pone la 38.
--
--  Correr como postgres:  sudo -u postgres psql -d bukeame -f database/41-schema-plazos.sql
-- ============================================================================

-- ALTER TYPE ADD VALUE NO puede ir dentro de una transacción (BEGIN/COMMIT).
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'klarna';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'affirm';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'acima';

BEGIN;

CREATE TABLE IF NOT EXISTS plazos_config (
  business_id  uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  klarna       text NOT NULL DEFAULT 'off' CHECK (klarna IN ('off','stripe','directo')),
  affirm       text NOT NULL DEFAULT 'off' CHECK (affirm IN ('off','stripe','directo')),
  acima_link   text CHECK (acima_link IS NULL OR length(acima_link) <= 500),
  stripe_caps  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {klarna:'active', affirm:'inactive'}
  caps_at      timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS acima_ok boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS cobro_enlaces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  appointment_id  uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  amount_cents    integer NOT NULL CHECK (amount_cents >= 0),
  tip_cents       integer NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  total_cents     integer NOT NULL CHECK (total_cents >= 50 AND total_cents = amount_cents + tip_cents),
  stripe_account  text,            -- la cuenta del negocio con la que se creó (el webhook compara con esta)
  session_id      text UNIQUE,
  url             text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','expired','cancelled')),
  method          payment_method,
  external_ref    text,
  payment_id      uuid REFERENCES payments(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at      timestamptz NOT NULL,
  paid_at         timestamptz,
  descuadre_at    timestamptz,     -- llegó un pago que no cuadra (se avisa una sola vez)
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cobro_enl_biz  ON cobro_enlaces(business_id, created_at DESC);
-- Un solo enlace abierto por cita (dos pestañas que piden enlace a la vez).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cobro_enl_open ON cobro_enlaces(appointment_id) WHERE status = 'open';

GRANT SELECT, INSERT, UPDATE, DELETE ON plazos_config, cobro_enlaces TO bukeame_user;

COMMIT;
