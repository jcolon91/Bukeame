-- ============================================================================
--  BUKEAME — Migración 38: add-on MEMBRESÍAS (paquetes prepagados del negocio)
--  Idempotente. Correr: sudo -u postgres psql -d bukeame -f database/38-schema-membresias.sql
-- ----------------------------------------------------------------------------
--  El negocio arma sus membresías (precio, duración, visitas, servicios y sus propios
--  términos) y sus clientes las pagan por adelantado con los métodos del negocio: el
--  dinero le llega directo, Bukéame no lo toca. El cliente usa sus visitas al reservar
--  con el código de su membresía.
--  · addon_catalog    : 'memberships' a $2.99/mes (como Lealtad).
--  · membership_plans : lo que el negocio vende.
--  · memberships      : cada una vendida, con copia de lo que el cliente aceptó.
--  · appointments     : qué membresía cubrió la cita y cuántas visitas gastó.
--  · payments         : el pago de una membresía es kind 'membership'.
-- ============================================================================

-- ALTER TYPE ADD VALUE NO puede ir dentro de una transacción (BEGIN/COMMIT).
ALTER TYPE addon_code ADD VALUE IF NOT EXISTS 'memberships';
ALTER TYPE payment_kind ADD VALUE IF NOT EXISTS 'membership';

BEGIN;

INSERT INTO addon_catalog (code, name, price_cents, billing, description) VALUES
('memberships', 'Membresías', 299, 'monthly',
 'Vende membresías y paquetes que tus clientes pagan por adelantado. Tú pones el precio, las visitas, los servicios y los términos.')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS membership_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  price_cents     integer NOT NULL CHECK (price_cents BETWEEN 100 AND 500000),
  period_unit     text NOT NULL CHECK (period_unit IN ('day','month')),
  period_count    smallint NOT NULL CHECK (period_count BETWEEN 1 AND 365),
  visits_included smallint CHECK (visits_included IS NULL OR visits_included BETWEEN 1 AND 999), -- NULL = sin límite
  service_ids     uuid[] NOT NULL DEFAULT '{}',       -- vacío = todos los servicios
  no_show_counts  boolean NOT NULL DEFAULT true,      -- si no llega, la visita cuenta
  terms           text NOT NULL,                      -- los términos del negocio, tal cual
  is_active       boolean NOT NULL DEFAULT true,      -- se vende en línea
  archived_at     timestamptz,                        -- "borrada": ya no sale en ningún lado
  sort_order      smallint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mplans_biz ON membership_plans(business_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS memberships (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  plan_id           uuid REFERENCES membership_plans(id) ON DELETE SET NULL,
  client_id         uuid REFERENCES clients(id) ON DELETE SET NULL,
  code              text NOT NULL UNIQUE,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','active','expired','cancelled')),
  buyer_name        text NOT NULL,
  phone             text NOT NULL,                    -- +1XXXXXXXXXX; con el código, abre la membresía
  email             text,
  source            text NOT NULL DEFAULT 'online' CHECK (source IN ('online','business')),
  -- Copia de lo que se compró: si el negocio cambia la membresía después, esta no cambia.
  name              text NOT NULL,
  price_cents       integer NOT NULL CHECK (price_cents > 0),
  period_unit       text NOT NULL CHECK (period_unit IN ('day','month')),
  period_count      smallint NOT NULL,
  visits_included   smallint,
  service_ids       uuid[] NOT NULL DEFAULT '{}',
  service_names     text[] NOT NULL DEFAULT '{}',
  no_show_counts    boolean NOT NULL DEFAULT true,
  terms             text NOT NULL,
  terms_accepted_at timestamptz,                      -- NULL si la vendió el negocio en persona
  -- Pago (directo al negocio)
  pay_option        text CHECK (pay_option IN ('ath_business','card','ath_manual','cash')),
  pay_ref           text,                             -- referencia que reportó el cliente o la de ATH/Stripe
  payment_id        uuid REFERENCES payments(id) ON DELETE SET NULL,
  -- Vigencia y uso
  starts_at         timestamptz,
  ends_at           timestamptz,
  visits_adjust     smallint NOT NULL DEFAULT 0,      -- visitas que el negocio descontó (+) o devolvió (-) a mano
  activated_at      timestamptz,
  cancelled_at      timestamptz,
  cancel_reason     text,
  reminder_sent_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memberships_biz ON memberships(business_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memberships_vence ON memberships(status, ends_at);
CREATE INDEX IF NOT EXISTS idx_memberships_client ON memberships(client_id);

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS membership_id uuid REFERENCES memberships(id) ON DELETE SET NULL;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS membership_visits smallint;
CREATE INDEX IF NOT EXISTS idx_appts_membership ON appointments(membership_id) WHERE membership_id IS NOT NULL;

-- Completar una cita ya pagada (membresía) se cobra en $0: antes eso chocaba con
-- CHECK (amount_cents > 0). Ahora vale $0 en el cobro de la cita si lleva propina.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_amount_cents_check;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_amount_ok;
ALTER TABLE payments ADD CONSTRAINT payments_amount_ok
  CHECK (amount_cents > 0 OR (kind = 'balance' AND amount_cents = 0 AND tip_cents > 0));

GRANT SELECT, INSERT, UPDATE, DELETE ON membership_plans, memberships TO bukeame_user;
GRANT SELECT ON addon_catalog TO bukeame_user;

COMMIT;
