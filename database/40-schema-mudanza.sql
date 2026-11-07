-- ============================================================================
--  BUKEAME — Migración 40: MUDANZA desde otra plataforma (Booksy, Fresha, GOLDIE…)
--  Idempotente. Correr: sudo -u postgres psql -d bukeame -f database/40-schema-mudanza.sql
--  Va después de la 38 (membresías): las membresías importadas usan su tabla.
-- ----------------------------------------------------------------------------
--  El negocio baja sus archivos de la plataforma vieja y los sube en el panel. El
--  archivo se lee en su propio equipo; aquí solo llegan las filas. Nada se guarda
--  hasta que el negocio ve el resumen y confirma, y la mudanza se puede deshacer.
--  · mudanzas             : cada mudanza (borrador mientras se revisa, luego lo que pasó).
--  · mudanza_items        : qué fila creó o cambió cada mudanza (para deshacerla).
--  · client_import_history: visitas de antes de Bukéame. NO son citas: no suben la
--                           lealtad, no disparan el "te toca" y no cuentan para las
--                           difusiones (esas piden su propio sí).
--  · imported_sales       : ventas de antes de Bukéame, aparte de la contabilidad
--                           (ya se reportaron en la otra plataforma).
--  · clients / appointments / gift_cards / memberships: de qué mudanza vienen.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS mudanzas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform    text NOT NULL,                         -- booksy | fresha | goldie | square | vagaro | otra | ninguna
  status      text NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','importing','done','undone','expired')),
  draft       jsonb,                                 -- las filas mientras se revisa; se borra al mudar o a las 24 h
  summary     jsonb NOT NULL DEFAULT '{}'::jsonb,    -- conteos: lo que pasó y lo que quedó fuera
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz,
  undone_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_mudanzas_biz ON mudanzas(business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mudanza_items (
  id         bigserial PRIMARY KEY,
  mudanza_id uuid NOT NULL REFERENCES mudanzas(id) ON DELETE CASCADE,
  entity     text NOT NULL,                          -- client | service | appointment | gift_card | membership | loyalty
  entity_id  uuid NOT NULL,
  action     text NOT NULL CHECK (action IN ('created','updated')),
  prev       jsonb                                   -- lo que había antes (solo en 'updated')
);
CREATE INDEX IF NOT EXISTS idx_mudanza_items ON mudanza_items(mudanza_id, entity);

CREATE TABLE IF NOT EXISTS client_import_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  mudanza_id   uuid NOT NULL REFERENCES mudanzas(id) ON DELETE CASCADE,
  source       text NOT NULL,                        -- la plataforma de donde vino
  occurred_at  timestamptz NOT NULL,
  service_name text,
  staff_name   text,
  price_cents  integer,
  status       text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','no_show')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cih_client ON client_import_history(client_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_cih_mudanza ON client_import_history(mudanza_id);

CREATE TABLE IF NOT EXISTS imported_sales (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  mudanza_id   uuid NOT NULL REFERENCES mudanzas(id) ON DELETE CASCADE,
  source       text NOT NULL,
  sold_at      timestamptz NOT NULL,
  description  text,
  client_name  text,
  amount_cents integer NOT NULL CHECK (amount_cents <> 0),   -- negativo = reembolso
  tip_cents    integer NOT NULL DEFAULT 0,
  tax_cents    integer NOT NULL DEFAULT 0,
  method       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_imported_sales_biz ON imported_sales(business_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_imported_sales_mudanza ON imported_sales(mudanza_id);

-- Resumen de antes de Bukéame por cliente (de su archivo de clientes o de su historial).
-- Aparte de total_visits/last_visit_at a propósito: esas mueven el "te toca".
ALTER TABLE clients ADD COLUMN IF NOT EXISTS import_source          text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS imported_visits        integer;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS imported_spent_cents   bigint;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS imported_last_visit_at timestamptz;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS mudanza_id uuid REFERENCES mudanzas(id) ON DELETE SET NULL;
ALTER TABLE gift_cards   ADD COLUMN IF NOT EXISTS mudanza_id uuid REFERENCES mudanzas(id) ON DELETE SET NULL;
-- El código que tenía en la otra plataforma. Solo para buscarla en el panel: el código
-- con que se usa es otro si el viejo era corto (adivinable) o ya existía en Bukéame.
ALTER TABLE gift_cards   ADD COLUMN IF NOT EXISTS legacy_code text;
ALTER TABLE memberships  ADD COLUMN IF NOT EXISTS mudanza_id uuid REFERENCES mudanzas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_appts_mudanza ON appointments(mudanza_id) WHERE mudanza_id IS NOT NULL;

-- Un paquete importado puede no traer su precio (ya se pagó en la otra plataforma).
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_price_cents_check;
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_price_ok;
ALTER TABLE memberships ADD CONSTRAINT memberships_price_ok CHECK (price_cents > 0 OR mudanza_id IS NOT NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON mudanzas, mudanza_items, client_import_history, imported_sales TO bukeame_user;
GRANT USAGE, SELECT ON SEQUENCE mudanza_items_id_seq TO bukeame_user;

COMMIT;
