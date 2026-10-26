// Diagnóstico de avisos de Bukéame (WhatsApp, email, recordatorios). SOLO LEE:
// no envía ningún mensaje ni cambia la base de datos. Imprime todo a stderr
// porque la terminal SSH del dueño solo muestra stderr.
// Uso (en el servidor):
//   cd /var/www/bukeame/backend && node diag-avisos.js
require('dotenv').config();
const { Pool } = require('pg');
const E = process.env;
const out = (...a) => console.error(...a);
const fmt = (d) => d ? new Date(d).toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico', dateStyle: 'short', timeStyle: 'short' }) : 'nunca';
const db = new Pool({ connectionString: E.DATABASE_URL, statement_timeout: 15000 });
const q = async (sql) => (await db.query(sql)).rows;

(async () => {
  out('=== Config (.env) ===');
  for (const k of ['EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE', 'RESEND_API_KEY', 'EMAIL_FROM', 'ATHM_PLATFORM_PUBLIC_TOKEN', 'VAPID_PUBLIC_KEY'])
    out('  ' + k.padEnd(28), E[k] ? 'presente' : 'FALTA');
  out('  ' + 'CORS_ORIGINS'.padEnd(28), E.CORS_ORIGINS || '(vacío)');

  out('=== WhatsApp (Evolution) ===');
  if (E.EVOLUTION_API_URL && E.EVOLUTION_API_KEY) {
    try {
      const r = await fetch(`${E.EVOLUTION_API_URL}/instance/connectionState/${E.EVOLUTION_INSTANCE || 'turnify'}`,
        { headers: { apikey: E.EVOLUTION_API_KEY } });
      out('  estado:', r.status, (await r.text()).slice(0, 160), '  <- debe decir "open"');
    } catch (e) { out('  estado: ERROR', e.message); }
  } else out('  sin URL o KEY: no sale ningún WhatsApp');

  out('=== Avisos de los últimos 7 días (canal, tipo, estado, cuántos, último) ===');
  const rows = await q(`SELECT channel, template, status, count(*)::int n, max(created_at) ultimo
                          FROM message_log WHERE created_at > now() - interval '7 days'
                         GROUP BY 1,2,3 ORDER BY 1,2,3`);
  if (!rows.length) out('  (ninguno)');
  for (const r of rows)
    out('  ' + r.channel.padEnd(9) + r.template.padEnd(15) + r.status.padEnd(8) + String(r.n).padStart(5), '  último:', fmt(r.ultimo));

  out('=== Último aviso enviado de verdad ===');
  for (const r of await q(`SELECT channel, max(sent_at) t FROM message_log WHERE status = 'sent' GROUP BY 1`))
    out('  ' + r.channel.padEnd(9), fmt(r.t));

  const [stuck] = await q(`SELECT count(*)::int n FROM message_log WHERE status = 'queued' AND created_at < now() - interval '5 minutes'`);
  out('=== Atascados en cola (más de 5 min) ===\n  ', stuck.n, stuck.n ? '<- PROBLEMA: no están saliendo' : '(bien)');

  out('=== Últimos 5 fallos ===');
  const fails = await q(`SELECT created_at, channel, template, error FROM message_log WHERE status = 'failed' ORDER BY created_at DESC LIMIT 5`);
  if (!fails.length) out('  (ninguno)');
  for (const f of fails) out('  ' + fmt(f.created_at), f.channel, f.template, '->', (f.error || '').slice(0, 120));

  out('=== Citas ===');
  const [a] = await q(`SELECT count(*) FILTER (WHERE created_at > now() - interval '7 days')::int nuevas7d,
                              count(*) FILTER (WHERE created_at > now() - interval '7 days' AND status IN ('cancelled_client','cancelled_business'))::int canceladas7d,
                              count(*) FILTER (WHERE status IN ('pending_deposit','confirmed') AND starts_at BETWEEN now() AND now() + interval '48 hours')::int proximas48h,
                              max(created_at) ultima
                         FROM appointments`);
  out('  nuevas (7 días):', a.nuevas7d, ' canceladas:', a.canceladas7d, ' próximas 48 h:', a.proximas48h, ' última reserva:', fmt(a.ultima));
  const [m] = await q(`SELECT count(*)::int n FROM appointments
                        WHERE status IN ('confirmed','completed') AND starts_at BETWEEN now() - interval '7 days' AND now()
                          AND created_at < starts_at - interval '25 hours' AND reminder_24h_sent_at IS NULL`);
  out('  citas de los últimos 7 días que debían tener recordatorio 24 h y no lo tienen:', m.n);

  // Misma regla que SQL_PAID_OK (commit 06284c8): quién conserva logo/banner/portafolio
  // y depósitos cuando se suba el gating del plan gratis.
  out('=== Negocios y su plan (pago_ok = conserva logo y depósitos con la regla nueva) ===');
  for (const b of await q(`SELECT b.slug, s.plan_code, s.status, s.trial_ends_at, s.current_period_end,
          (s.plan_code IS NOT NULL AND s.plan_code <> 'free' AND s.status <> 'cancelled'
           AND NOT (s.status = 'trialing' AND (s.trial_ends_at IS NULL OR s.trial_ends_at <= now()))
           AND (s.current_period_end IS NULL OR now() <= s.current_period_end + interval '7 days')) AS pago_ok,
          COALESCE(s.plan_code <> 'free' AND (p.features->>'deposits')::boolean, false) AS deposits_enabled,
          (b.logo_url IS NOT NULL) AS tiene_logo
     FROM businesses b LEFT JOIN subscriptions s ON s.business_id = b.id
     LEFT JOIN plans p ON p.code = s.plan_code
    ORDER BY b.created_at DESC LIMIT 30`))
    out('  ' + String(b.slug).padEnd(28) + String(b.plan_code).padEnd(10) + String(b.status).padEnd(10),
      'prueba:', fmt(b.trial_ends_at), ' periodo:', fmt(b.current_period_end),
      ' pago_ok:', b.pago_ok ? 'SÍ' : 'NO', ' depósitos:', b.deposits_enabled ? 'sí' : 'no', ' logo:', b.tiene_logo ? 'sí' : 'no');
  await db.end();
})().catch((e) => { out('ERROR del diagnóstico:', e.message); process.exit(1); });
