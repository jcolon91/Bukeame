-- ============================================================================
--  BUKEAME — Migración 37: COBRO CON TARJETA (Stripe Billing) para plan y add-ons
--  Idempotente. Correr: sudo -u postgres psql -d bukeame -f database/37-schema-cobro-tarjeta.sql
-- ----------------------------------------------------------------------------
--  El dueño puede pagar su plan o sus add-ons con tarjeta y se renuevan solos
--  cada mes (suscripción de Stripe en la cuenta de Wifnix). ATH sigue igual.
--  · subscriptions.stripe_subscription_id / stripe_customer_id ya existían (01).
--  · subscriptions.stripe_item_id : el renglón del plan dentro de esa suscripción.
--  · addons.stripe_subscription_id / stripe_item_id : igual para cada add-on. Una
--    compra de varios add-ons es UNA suscripción con varios renglones.
--  · platform_payments (ledger de 01) guarda cada factura pagada con tarjeta. El
--    índice único por factura evita registrar (y avisar) dos veces el mismo pago.
--  El acceso sigue saliendo de current_period_end (+7 días de gracia), igual que
--  con ATH: solo una factura PAGADA lo mueve.
-- ============================================================================
BEGIN;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_item_id text;
ALTER TABLE addons ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
ALTER TABLE addons ADD COLUMN IF NOT EXISTS stripe_item_id text;

CREATE INDEX IF NOT EXISTS idx_addons_stripe_sub
  ON addons (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_payments_card_ref
  ON platform_payments (external_ref) WHERE method = 'card' AND external_ref IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON platform_payments TO bukeame_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON subscriptions, addons TO bukeame_user;

COMMIT;
