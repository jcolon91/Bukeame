-- ============================================================================
--  32-schema-admin-2fa.sql
--  2FA (TOTP) SOLO para cuentas de administrador de plataforma (is_platform_admin).
--  Los negocios/clientes NO se ven afectados: si totp_enabled = false, el login
--  sigue igual. El secreto se guarda CIFRADO (AES-256-GCM, clave derivada del
--  JWT_SECRET del server) — nunca en claro.
--  Idempotente: se puede correr varias veces sin error.
--  Correr como postgres:
--    sudo -u postgres psql -d bukeame -f /var/www/bukeame/database/32-schema-admin-2fa.sql
--  Las columnas nuevas heredan los privilegios de la tabla users → NO requiere
--  re-GRANT a bukeame_user.
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret       TEXT;                       -- secreto TOTP cifrado (base64: iv|tag|ct); NULL hasta enrolar
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled      BOOLEAN NOT NULL DEFAULT false; -- true solo tras confirmar un código válido
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes JSONB;                      -- array de hashes sha256 (hex) de códigos de respaldo SIN usar

-- (Opcional/defensivo) por si en el futuro se corre en una DB donde users no tiene los grants:
-- GRANT SELECT, INSERT, UPDATE, DELETE ON users TO bukeame_user;
