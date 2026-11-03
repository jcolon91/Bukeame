-- ============================================================================
--  BUKEAME — Migración 36: add-on RECUPERA CLIENTES (campañas por email)
--  Idempotente. Correr: sudo -u postgres psql -d bukeame -f database/36-schema-recupera-clientes.sql
-- ----------------------------------------------------------------------------
--  Servicio hecho por Wifnix: Bukéame prepara las campañas con los datos del negocio,
--  la IA las redacta, una persona de Wifnix las aprueba y salen a los clientes del
--  propio negocio. Después se mide quién volvió a reservar.
--  · addon_catalog : 'win_back' a $49/mes (1,500 emails por periodo pagado).
--  · rc_settings   : lo que el dueño ajusta (oferta, enlace de reseñas en Google…).
--  · rc_campaigns  : cada campaña (borrador → revisión → aprobada → enviada).
--  · rc_recipients : a quién le salió (el id es el token del enlace y de la baja),
--                    si tocó el enlace y qué cita hizo después. Los del grupo de
--                    control (holdout) no reciben nada: sirven para comparar.
--  · clients       : baja de los emails del negocio y cuándo se le escribió.
-- ============================================================================

-- ALTER TYPE ADD VALUE NO puede ir dentro de una transacción (BEGIN/COMMIT).
ALTER TYPE addon_code ADD VALUE IF NOT EXISTS 'win_back';

BEGIN;

INSERT INTO addon_catalog (code, name, price_cents, billing, description) VALUES
('win_back', 'Recupera clientes', 4900, 'monthly',
 'Le escribimos por email a tus clientes que no han vuelto y a los que pueden dejarte una reseña. La IA redacta, Wifnix revisa y te enseñamos quién volvió.')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS email_opt_out_at timestamptz;   -- se dio de baja de los emails del negocio
ALTER TABLE clients ADD COLUMN IF NOT EXISTS mkt_last_sent_at timestamptz;   -- último email de campaña
ALTER TABLE clients ADD COLUMN IF NOT EXISTS review_asked_at  timestamptz;   -- última vez que se le pidió reseña

CREATE TABLE IF NOT EXISTS rc_settings (
  business_id       uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  enabled           boolean NOT NULL DEFAULT true,       -- el dueño puede pausar las campañas
  offer_text        text,                                -- oferta del dueño, tal cual (la IA no inventa otras)
  google_review_url text,                                -- sin él no se piden reseñas
  lapsed_days       smallint NOT NULL DEFAULT 45,        -- "no ha vuelto" para clientes con pocas visitas
  emails_included   integer NOT NULL DEFAULT 1500,       -- por periodo pagado del add-on
  last_report_month text,                                -- 'AAAA-MM' del último informe mensual enviado
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rc_campaigns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('winback','review')),
  status         text NOT NULL DEFAULT 'pending_review'
                 CHECK (status IN ('pending_review','approved','sending','sent','rejected','cancelled')),
  subject        text NOT NULL,
  preheader      text,
  body           text NOT NULL,                          -- texto con {{nombre}}; párrafos separados por línea en blanco
  cta            text NOT NULL,
  ai_model       text,                                   -- modelo que lo redactó, o 'plantilla'
  ai_draft       jsonb,                                  -- lo que propuso la IA (para medir cuánto se corrige)
  facts          jsonb,                                  -- datos que se le dieron (para que el revisor los compare)
  audience_count integer NOT NULL DEFAULT 0,             -- tamaño del público al preparar
  review_note    text,                                   -- nota del revisor (rechazo o pedido de cambio)
  reviewed_by    uuid REFERENCES users(id),
  reviewed_at    timestamptz,
  edited         boolean,                                -- el revisor cambió el texto antes de aprobar
  send_at        timestamptz,                            -- cuándo sale (el dueño puede detenerla antes)
  sent_at        timestamptz,
  sent_count     integer NOT NULL DEFAULT 0,
  holdout_count  integer NOT NULL DEFAULT 0,
  capped         integer NOT NULL DEFAULT 0,             -- los que no cupieron en los emails del periodo
  cancelled_by   text,                                   -- 'owner' | 'admin'
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rc_campaigns_biz ON rc_campaigns(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rc_campaigns_cola ON rc_campaigns(status, send_at);

CREATE TABLE IF NOT EXISTS rc_recipients (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- token de los enlaces
  campaign_id           uuid NOT NULL REFERENCES rc_campaigns(id) ON DELETE CASCADE,
  business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id             uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email                 text NOT NULL,
  holdout               boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sending','sent','failed','held_out')),
  provider_ref          text,
  error                 text,
  sent_at               timestamptz,
  clicked_at            timestamptz,
  booked_appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  unsubscribed_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_rc_recipients_camp ON rc_recipients(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_rc_recipients_atrib ON rc_recipients(business_id, created_at)
  WHERE booked_appointment_id IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON rc_settings, rc_campaigns, rc_recipients TO bukeame_user;
GRANT SELECT ON addon_catalog TO bukeame_user;

COMMIT;
