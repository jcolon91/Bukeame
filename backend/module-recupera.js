// ============================================================================
//  BUKEAME API — módulo RECUPERA CLIENTES (add-on 'win_back', campañas por email)
// ----------------------------------------------------------------------------
//  Es un servicio, no una herramienta: el dueño no arma nada. Bukéame mira sus datos,
//  prepara la campaña, la IA (Claude) la redacta con sus servicios y precios reales,
//  una persona de Wifnix la aprueba y sale a los clientes del propio negocio. Después
//  se mide quién volvió a reservar.
//
//  Campañas:
//    winback → clientes que ya vinieron y no han vuelto (según su propio ritmo de
//              visitas; con pocas visitas, los días que puso el negocio). Cada 14 días.
//    review  → clientes que vinieron en la última semana: reseña en Google. Cada 7 días.
//
//  Reglas que protegen al cliente y al número del negocio:
//    · Solo clientes con al menos una cita cumplida (nunca listas compradas ni frío).
//    · Baja con un toque en cada email (y List-Unsubscribe de un clic para Gmail/Yahoo).
//    · Un cliente no recibe dos campañas en 21 días, ni reseña más de una vez en 120.
//    · Cada email lleva la dirección del negocio (CAN-SPAM); sin dirección no se prepara.
//    · La IA no inventa ofertas: solo copia la del dueño, si la puso.
//
//  Medición honesta: con 40 o más en el público, el 10 % no recibe el email (grupo de
//  control). El informe compara cuántos volvieron con y sin el email.
//
//  Rutas:
//    Panel    GET/PUT /api/recupera, GET /api/recupera/campanas/:id/vista,
//             POST /api/recupera/campanas/:id/detener
//    Admin    GET /api/admin/recupera, POST /api/admin/recupera/campanas/:id/(aprobar|rechazar|rehacer),
//             POST /api/admin/recupera/negocios/:id/preparar
//    Público  GET /api/r/:token (enlace del email), GET/POST /api/public/baja/:token[/un-clic]
//
//  Llaves (.env): RESEND_API_KEY + EMAIL_FROM_CAMPANAS (remitente del subdominio de
//  campañas). Sin las dos, el add-on no se vende ni envía. ANTHROPIC_API_KEY es para
//  que redacte la IA; sin ella usa plantillas escritas a mano.
// ============================================================================

const PR_TZ = 'America/Puerto_Rico';
const ADDON = 'win_back';
const VENTANA_DIAS = 14;       // "volvió": reservó en los 14 días después del email
const ENFRIAR_DIAS = 21;       // ningún cliente recibe dos campañas en 21 días
const CADA = { winback: 14, review: 7 };
const MINIMO = { winback: 5, review: 3 };
const CONTROL_DESDE = 40;      // con 40+ en el público, el 10 % va al grupo de control
const ESPERA_ENVIO_MS = 550;   // Resend permite unas 2 llamadas por segundo
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const DOMINIOS_RESENA = ['g.page', 'google.com', 'www.google.com', 'search.google.com', 'maps.google.com', 'maps.app.goo.gl', 'goo.gl', 'g.co'];

// Tipo de negocio (slug de la categoría) → cómo se nombra en el email
const TIPOS = {
  barberia: 'barbería', salon: 'salón de belleza', unas: 'salón de uñas', estetica: 'centro de estética',
  lashes: 'estudio de pestañas y cejas', spa: 'spa', maquillaje: 'estudio de maquillaje', tattoo: 'estudio de tatuajes',
  'pet-grooming': 'grooming de mascotas', bienestar: 'centro de bienestar', waxing: 'estudio de waxing',
};
const NOMBRE_TIPO = { winback: 'Te extrañamos', review: 'Reseña en Google' };

const dinero = (c) => { const n = Number(c || 0) / 100; return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Texto de campaña: sin enlaces (el botón ya lleva uno), sin emojis y sin caracteres de control
const sinEnlaces = (s) => String(s || '')
  .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
  .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|info|biz|io|co|ly|me|app|link|xyz|site|online|shop|pr|us|gl|to|cc)\b\S*/gi, '');
const limpio = (s, max) => sinEnlaces(s).replace(/\p{Extended_Pictographic}|️/gu, '')
  .replace(/[\u0000-\u0009\u000B-\u001F\u007F]+/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const unaLinea = (s, max) => limpio(String(s || '').replace(/\s+/g, ' '), max);
const primerNombre = (n) => String(n || '').trim().split(/\s+/)[0].replace(/[^\p{L}'-]/gu, '').slice(0, 30);
const fechaPR = (d) => new Date(d).toLocaleDateString('es-PR', { timeZone: PR_TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const mesPR = (d) => new Date(d).toLocaleDateString('es-PR', { timeZone: PR_TZ, month: 'long' });
// Puerto Rico no cambia la hora: UTC-4 todo el año
const ahoraPR = () => new Date(Date.now() - 4 * 3600e3);

// Próximas 10:00 a. m. de PR con al menos 12 horas para que el dueño la pueda detener
function proximaSalida(desde = Date.now()) {
  const pr = new Date(desde - 4 * 3600e3);
  let t = Date.UTC(pr.getUTCFullYear(), pr.getUTCMonth(), pr.getUTCDate(), 14, 0, 0);   // 10:00 PR = 14:00 UTC
  while (t < desde + 12 * 3600e3) t += 864e5;
  return new Date(t);
}

function urlResena(u) {
  if (!u) return null;
  try {
    const x = new URL(String(u).trim());
    if (x.protocol !== 'https:' || !DOMINIOS_RESENA.includes(x.hostname.toLowerCase())) return null;
    return x.toString().slice(0, 500);
  } catch (e) { return null; }
}
function colorDe(theme) {
  const c = theme && typeof theme.accent === 'string' ? theme.accent : '';
  return /^#[0-9a-f]{6}$/i.test(c) ? c : '#0E8074';
}
function tintaSobre(hex) {   // texto del botón legible sobre el color del negocio
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#17150F' : '#FFFFFF';
}

// ---------- Plantillas (sin IA, o si la IA falla) ----------
function plantilla(kind, f) {
  if (kind === 'review') return {
    subject: `¿Cómo te fue en ${f.negocio}?`.slice(0, 70),
    preheader: 'Tu opinión ayuda a que más gente nos encuentre.',
    body: `Hola {{nombre}},\n\nGracias por visitarnos. Si tienes un minuto, nos ayudaría mucho que dejaras una reseña en Google contando cómo te fue. Así más gente${f.pueblo ? ` de ${f.pueblo}` : ''} nos encuentra.\n\nGracias por confiar en nosotros.\n${f.negocio}`,
    cta: 'Dejar mi reseña',
  };
  return {
    subject: `Hace tiempo no te vemos en ${f.negocio}`.slice(0, 70),
    preheader: 'Tu próximo turno está a un toque.',
    body: `Hola {{nombre}},\n\nHace un tiempito que no pasas por ${f.negocio} y queríamos saber de ti. Cuando quieras volver, reservas en un minuto desde tu celular, sin llamar.\n\n${f.oferta ? f.oferta + '\n\n' : ''}Te esperamos.\n${f.negocio}`,
    cta: 'Reservar mi turno',
  };
}

// ---------- La IA que redacta (Claude) ----------
const SISTEMA = `Redactas los emails de campaña de negocios pequeños de Puerto Rico que usan Bukéame. Escribes en español de Puerto Rico, de tú, cálido y directo, como le escribiría el propio negocio a un cliente que ya conoce.

Reglas que no se rompen:
- Usa solo los datos que te doy. No inventes precios, descuentos, ofertas, fechas, horarios, servicios ni premios. Si hay una oferta del dueño, cópiala tal cual; si no hay, no menciones ninguna.
- Nada de urgencia falsa ("solo hoy", "últimos cupos") ni de hacer sentir culpable al cliente.
- Sin emojis, sin enlaces ni direcciones web (el botón ya lleva el enlace) y sin MAYÚSCULAS para gritar.
- El cuerpo empieza con "Hola {{nombre}}," en su propia línea. {{nombre}} se cambia por el nombre del cliente; no uses otras variables.
- Dos o tres párrafos cortos, de 600 caracteres como máximo en total, separados por una línea en blanco. Termina con el nombre del negocio en la última línea.
- Asunto de 55 caracteres como máximo, sin "Re:" ni nada engañoso. El preencabezado (90 caracteres como máximo) completa el asunto sin repetirlo.
- Botón de 2 a 4 palabras.
- Si es para pedir reseña: pide una reseña honesta en Google, no ofrezcas nada a cambio y no pidas cinco estrellas.`;

const ESQUEMA = {
  type: 'object',
  properties: {
    asunto: { type: 'string' },
    preencabezado: { type: 'string' },
    cuerpo: { type: 'string' },
    boton: { type: 'string' },
  },
  required: ['asunto', 'preencabezado', 'cuerpo', 'boton'],
  additionalProperties: false,
};

let claudeCliente;   // undefined = sin probar · null = no disponible
function claude() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (claudeCliente === undefined) {
    try { const Anthropic = require('@anthropic-ai/sdk'); claudeCliente = new Anthropic(); }
    catch (e) { console.error('recupera: falta @anthropic-ai/sdk (corre npm install en backend):', e.message); claudeCliente = null; }
  }
  return claudeCliente;
}

function pedidoIA(kind, f, nota) {
  return [
    `Tipo de campaña: ${kind === 'review' ? 'pedir una reseña en Google a quien vino en la última semana' : 'clientes que ya vinieron y hace tiempo no reservan'}`,
    `Negocio: ${f.negocio}${f.tipo ? ` (${f.tipo}${f.pueblo ? ` en ${f.pueblo}` : ''})` : f.pueblo ? ` (en ${f.pueblo})` : ''}`,
    `Servicios y precios: ${f.servicios.length ? f.servicios.map((s) => `${s.nombre} ${s.precio}`).join('; ') : 'no los menciones'}`,
    `Oferta del dueño: ${f.oferta ? `"${f.oferta}"` : 'ninguna (no menciones ofertas)'}`,
    `Clientes que lo van a recibir: ${f.publico}`,
    `Fecha de hoy: ${f.hoy}`,
    f.asuntos_previos.length ? `Asuntos que ya se usaron (no los repitas): ${f.asuntos_previos.join(' | ')}` : '',
    nota ? `Pedido del revisor de Wifnix: ${nota}` : '',
  ].filter(Boolean).join('\n');
}

async function redactar(kind, f, nota) {
  const base = plantilla(kind, f);
  const ia = claude();
  if (!ia) return { ...base, model: 'plantilla' };
  const model = process.env.RECUPERA_MODELO || 'claude-opus-5-5';
  try {
    const r = await ia.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ESQUEMA } },
      system: SISTEMA,
      messages: [{ role: 'user', content: pedidoIA(kind, f, nota) }],
    });
    if (r.stop_reason === 'refusal' || r.stop_reason === 'max_tokens') throw new Error('la IA no terminó: ' + r.stop_reason);
    const txt = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const j = JSON.parse(txt);
    let body = limpio(j.cuerpo, 1200);
    if (!body.includes('{{nombre}}')) body = 'Hola {{nombre}},\n\n' + body;
    const out = {
      subject: unaLinea(j.asunto, 70), preheader: unaLinea(j.preencabezado, 110),
      body, cta: unaLinea(j.boton, 30), model: r.model || model,
    };
    if (!out.subject || !out.cta || body.length < 60) throw new Error('respuesta incompleta');
    return out;
  } catch (e) {
    console.error('recupera IA:', e.message);
    return { ...base, model: 'plantilla' };
  }
}

// ---------- El email ----------
function emailDe({ c, biz, nombre, ctaUrl, bajaUrl }) {
  const color = colorDe(biz.theme), tinta = tintaSobre(color);
  const cuerpo = String(c.body).replace(/\{\{nombre\}\}/g, nombre || '').replace(/Hola ,/g, 'Hola,');
  const parrafos = cuerpo.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const direccion = [biz.address_line, biz.pueblo].filter(Boolean).join(', ');
  const pie = `Te escribimos porque eres cliente de ${biz.name}. ${direccion}.`;
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#F4F2EA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#17150F">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#F4F2EA">${esc(c.preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F2EA;padding:28px 14px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#FFFFFF;border:1px solid #E1DCCD;border-radius:16px;overflow:hidden">
<tr><td style="height:5px;background:${color};line-height:5px;font-size:5px">&nbsp;</td></tr>
<tr><td style="padding:24px 28px 6px 28px;font-size:19px;font-weight:800;letter-spacing:-.01em">${esc(biz.name)}</td></tr>
<tr><td style="padding:8px 28px 4px 28px;font-size:15.5px;line-height:1.6">${parrafos.map((p) => `<p style="margin:0 0 14px 0">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</td></tr>
<tr><td style="padding:6px 28px 28px 28px"><a href="${esc(ctaUrl)}" style="display:inline-block;background:${color};color:${tinta};font-weight:700;font-size:15px;text-decoration:none;padding:13px 24px;border-radius:12px">${esc(c.cta)}</a></td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%"><tr><td style="padding:16px 10px;font-size:12px;line-height:1.55;color:#6B6658;text-align:center">
${esc(pie)}<br><a href="${esc(bajaUrl)}" style="color:#6B6658;text-decoration:underline">No quiero recibir más emails de ${esc(biz.name)}</a><br><span style="color:#9A9484">Enviado con Bukéame</span>
</td></tr></table>
</td></tr></table></body></html>`;
  const text = `${parrafos.join('\n\n')}\n\n${c.cta}: ${ctaUrl}\n\n--\n${pie}\nPara no recibir más emails de ${biz.name}: ${bajaUrl}`;
  return { html, text };
}

module.exports.mount = function (app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, isUuid, alertOwner, audit, codeLimiter } = h;
  const SITE = () => process.env.RECUPERA_BASE_URL || 'https://bukeame.com';
  const listo = h.recuperaLista || (() => !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM_CAMPANAS));
  const PANEL = [authRequired, businessScope];
  const adminRequired = (req, res, next) => (req.user && req.user.is_platform_admin ? next() : bad(res, 'Acceso restringido al administrador', 403));
  const ADMIN = [authRequired, adminRequired];

  // ---------- Add-on, periodo y ajustes ----------
  async function addonActivo(businessId) {
    try {
      const { rows } = await db.query(
        `SELECT 1 FROM addons WHERE business_id = $1 AND code = $2 AND status = 'active'
           AND (current_period_end IS NULL OR now() <= current_period_end + interval '7 days')`, [businessId, ADDON]);
      return !!rows[0];
    } catch (e) {
      if (e.code === '22P02') return false;   // sin la migración 36 el enum no tiene el código
      throw e;
    }
  }

  // Periodo = el bloque de 30 días pagado del add-on que contiene "ahora" (como la recepcionista)
  async function periodo(businessId) {
    const r = (await db.query(
      `SELECT CASE
                WHEN current_period_end IS NULL THEN NULL
                WHEN now() >= current_period_end THEN current_period_end - interval '30 days'
                ELSE current_period_end - interval '30 days' * ceil(extract(epoch FROM current_period_end - now()) / 2592000.0)
              END AS inicio
         FROM addons WHERE business_id = $1 AND code::text = $2`, [businessId, ADDON]).catch(() => ({ rows: [] }))).rows[0];
    let inicio = r && r.inicio ? new Date(r.inicio) : null;
    if (!inicio) {
      const m = (await db.query(`SELECT date_trunc('month', now() AT TIME ZONE '${PR_TZ}') AT TIME ZONE '${PR_TZ}' AS m`)).rows[0];
      inicio = new Date(m.m);
      const fin = new Date(inicio); fin.setUTCMonth(fin.getUTCMonth() + 1);
      return { inicio, fin };
    }
    return { inicio, fin: new Date(inicio.getTime() + 30 * 864e5) };
  }

  async function enviadosDesde(businessId, inicio) {
    const { rows } = await db.query(
      `SELECT count(*)::int n FROM rc_recipients WHERE business_id = $1 AND status IN ('sent','sending') AND sent_at >= $2`,
      [businessId, inicio]);
    return rows[0].n;
  }

  async function ajustes(businessId) {
    const { rows } = await db.query(`SELECT * FROM rc_settings WHERE business_id = $1`, [businessId]);
    return rows[0] || { enabled: true, offer_text: null, google_review_url: null, lapsed_days: 45, emails_included: 1500 };
  }

  async function negocio(businessId) {
    const { rows } = await db.query(
      `SELECT b.id, b.name, b.slug, b.email, b.address_line, b.theme, b.deleted_at, m.name AS pueblo, u.email AS owner_email,
              (SELECT c.slug FROM business_categories bc JOIN categories c ON c.id = bc.category_id
                WHERE bc.business_id = b.id LIMIT 1) AS cat
         FROM businesses b JOIN users u ON u.id = b.owner_user_id
         LEFT JOIN pr_municipalities m ON m.id = b.municipality_id
        WHERE b.id = $1`, [businessId]);
    return rows[0] || null;
  }

  // ---------- Públicos ----------
  // Cliente con email válido, sin baja, no bloqueado y sin campaña en los últimos 21 días.
  const BASE_CLIENTE = `c.business_id = $1 AND c.email IS NOT NULL AND c.email ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]{2,}$'
     AND c.email_opt_out_at IS NULL AND NOT c.is_blocked
     AND (c.mkt_last_sent_at IS NULL OR c.mkt_last_sent_at < now() - interval '${ENFRIAR_DIAS} days')`;
  // Una visita = cita completada, o confirmada que ya pasó (muchos negocios no marcan "completada")
  const VISITA = `(a.status = 'completed' OR (a.status = 'confirmed' AND a.ends_at < now()))`;

  async function publico(kind, businessId, lapsedDays) {
    if (kind === 'review') {
      return (await db.query(
        `SELECT c.id, c.email, c.full_name, c.total_spent_cents FROM clients c
          WHERE ${BASE_CLIENTE.replace(`interval '${ENFRIAR_DIAS} days'`, `interval '3 days'`)}
            AND (c.review_asked_at IS NULL OR c.review_asked_at < now() - interval '120 days')
            AND EXISTS (SELECT 1 FROM appointments a WHERE a.client_id = c.id AND a.business_id = $1 AND ${VISITA}
                          AND a.ends_at > now() - interval '8 days' AND a.ends_at < now() - interval '12 hours')
          ORDER BY c.full_name`, [businessId])).rows;
    }
    // "No ha vuelto" según su propio ritmo: con 3+ visitas, 1.5 veces su tiempo promedio entre
    // visitas (entre 21 y 120 días); con menos, los días del negocio. Solo si vino en el último
    // año y no tiene otra cita por delante.
    return (await db.query(
      `WITH v AS (
         SELECT a.client_id, count(*)::int n, min(a.starts_at) f, max(a.starts_at) l
           FROM appointments a WHERE a.business_id = $1 AND ${VISITA} GROUP BY a.client_id)
       SELECT c.id, c.email, c.full_name, c.total_spent_cents FROM clients c JOIN v ON v.client_id = c.id
        WHERE ${BASE_CLIENTE}
          AND v.l > now() - interval '365 days'
          AND v.l < now() - make_interval(days => (CASE WHEN v.n >= 3
                THEN LEAST(120, GREATEST(21, 1.5 * extract(epoch FROM v.l - v.f) / 86400.0 / (v.n - 1)))
                ELSE $2 END)::int)
          AND NOT EXISTS (SELECT 1 FROM appointments x WHERE x.client_id = c.id
                            AND x.status IN ('pending_deposit','confirmed') AND x.starts_at > now())
        ORDER BY v.l DESC`, [businessId, lapsedDays || 45])).rows;
  }

  async function hechos(kind, biz, aj, n) {
    const [svc, prev] = await Promise.all([
      db.query(`SELECT name, price_cents FROM services WHERE business_id = $1 AND is_active AND deleted_at IS NULL
                 ORDER BY is_featured DESC, sort_order, price_cents DESC LIMIT 8`, [biz.id]),
      db.query(`SELECT subject FROM rc_campaigns WHERE business_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 4`, [biz.id, kind]),
    ]);
    return {
      negocio: biz.name, tipo: TIPOS[biz.cat] || '', pueblo: biz.pueblo || '',
      servicios: svc.rows.map((s) => ({ nombre: unaLinea(s.name, 60), precio: s.price_cents > 0 ? dinero(s.price_cents) : '' })),
      oferta: aj.offer_text ? unaLinea(aj.offer_text, 140) : '',
      publico: n, hoy: fechaPR(Date.now()), asuntos_previos: prev.rows.map((r) => r.subject),
    };
  }

  // Prepara un borrador que espera la revisión de Wifnix. Devuelve la campaña o la razón.
  async function preparar(businessId, kind, { forzar = false } = {}) {
    const biz = await negocio(businessId);
    if (!biz || biz.deleted_at) return { motivo: 'negocio no encontrado' };
    if (!biz.address_line) return { motivo: 'falta la dirección del negocio' };
    const aj = await ajustes(businessId);
    if (!aj.enabled && !forzar) return { motivo: 'el dueño pausó las campañas' };
    if (kind === 'review' && !urlResena(aj.google_review_url)) return { motivo: 'falta el enlace de reseñas en Google' };
    const abierta = (await db.query(
      `SELECT 1 FROM rc_campaigns WHERE business_id = $1 AND kind = $2 AND status IN ('pending_review','approved','sending')`,
      [businessId, kind])).rows[0];
    if (abierta) return { motivo: 'ya hay una campaña de este tipo en camino' };
    const per = await periodo(businessId);
    if (await enviadosDesde(businessId, per.inicio) >= (aj.emails_included || 1500)) return { motivo: 'se usaron los emails del periodo' };
    const lista = await publico(kind, businessId, aj.lapsed_days);
    if (lista.length < (forzar ? 1 : MINIMO[kind])) return { motivo: `pocos clientes para esta campaña (${lista.length})` };
    const f = await hechos(kind, biz, aj, lista.length);
    const d = await redactar(kind, f);
    const { rows } = await db.query(
      `INSERT INTO rc_campaigns (business_id, kind, subject, preheader, body, cta, ai_model, ai_draft, facts, audience_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [businessId, kind, d.subject, d.preheader, d.body, d.cta, d.model,
       JSON.stringify({ subject: d.subject, preheader: d.preheader, body: d.body, cta: d.cta }), JSON.stringify(f), lista.length]);
    return { campana: rows[0] };
  }

  // ---------- Worker: preparar campañas (cada hora) ----------
  async function planificar() {
    let negocios;
    try {
      negocios = (await db.query(
        `SELECT a.business_id FROM addons a JOIN businesses b ON b.id = a.business_id AND b.deleted_at IS NULL
          WHERE a.code = $1 AND a.status = 'active'
            AND (a.current_period_end IS NULL OR now() <= a.current_period_end + interval '7 days')`, [ADDON])).rows;
    } catch (e) { if (e.code === '22P02' || e.code === '42P01') return; throw e; }
    for (const { business_id: bid } of negocios) {
      for (const kind of ['winback', 'review']) {
        try {
          // Una detenida por el dueño o rechazada por Wifnix también cuenta: no se rehace sola
          // (para otra antes de tiempo está "Preparar una ahora"). Solo se reintenta la que
          // canceló el sistema (venció el add-on, faltaba la dirección).
          const ultima = (await db.query(
            `SELECT 1 FROM rc_campaigns WHERE business_id = $1 AND kind = $2
                AND NOT (status = 'cancelled' AND cancelled_by = 'system')
                AND created_at > now() - make_interval(days => $3)`,
            [bid, kind, CADA[kind]])).rows[0];
          if (!ultima) await preparar(bid, kind);
        } catch (e) { console.error('recupera planificar:', e.message); }
      }
    }
  }

  // ---------- Worker: enviar (cada 2 min) ----------
  async function resend(payload, idem) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Idempotency-Key': idem },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) { const e = new Error(`Resend ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`); e.status = r.status; throw e; }
    return (await r.json().catch(() => ({}))).id || null;
  }
  function remitente(nombre) {
    const m = String(process.env.EMAIL_FROM_CAMPANAS || '').match(/<([^>]+)>/);
    const dir = (m ? m[1] : String(process.env.EMAIL_FROM_CAMPANAS || '')).trim();
    return `"${String(nombre).replace(/["<>@,;:\\\r\n]/g, '').slice(0, 60).trim() || 'Bukéame'}" <${dir}>`;
  }

  // Al salir se vuelve a calcular el público (quien reservó o se dio de baja desde el
  // borrador ya no entra), se aparta el grupo de control y se respeta el cupo del periodo.
  async function armarDestinatarios(c, aj) {
    const lista = await publico(c.kind, c.business_id, aj.lapsed_days);
    let control = [];
    let enviar = lista;
    if (c.kind === 'winback' && lista.length >= CONTROL_DESDE) {
      const mezcla = lista.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      control = mezcla.slice(0, Math.floor(lista.length / 10));
      const fuera = new Set(control.map((x) => x.id));
      enviar = lista.filter((x) => !fuera.has(x.id));
    }
    const per = await periodo(c.business_id);
    const quedan = Math.max(0, (aj.emails_included || 1500) - await enviadosDesde(c.business_id, per.inicio));
    let capped = 0;
    if (enviar.length > quedan) {   // primero los que más han gastado en el negocio
      capped = enviar.length - quedan;
      enviar = enviar.slice().sort((a, b) => Number(b.total_spent_cents || 0) - Number(a.total_spent_cents || 0)).slice(0, quedan);
    }
    const cli = await db.connect();
    try {
      await cli.query('BEGIN');
      for (const x of enviar)
        await cli.query(`INSERT INTO rc_recipients (campaign_id, business_id, client_id, email) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [c.id, c.business_id, x.id, String(x.email).trim()]);
      for (const x of control)
        await cli.query(`INSERT INTO rc_recipients (campaign_id, business_id, client_id, email, holdout, status)
                         VALUES ($1,$2,$3,$4,true,'held_out') ON CONFLICT DO NOTHING`, [c.id, c.business_id, x.id, String(x.email).trim()]);
      await cli.query(`UPDATE rc_campaigns SET holdout_count = $2, capped = $3 WHERE id = $1`, [c.id, control.length, capped]);
      await cli.query('COMMIT');
    } catch (e) { await cli.query('ROLLBACK').catch(() => {}); throw e; }
    finally { cli.release(); }
    return enviar.length;
  }

  async function enviarCampana(c) {
    const aj = await ajustes(c.business_id);
    if (!(await addonActivo(c.business_id)) || !aj.enabled) {
      await db.query(`UPDATE rc_campaigns SET status = 'cancelled', cancelled_by = 'system',
                             review_note = COALESCE(review_note, $2) WHERE id = $1`,
        [c.id, aj.enabled ? 'Venció el add-on antes de salir.' : 'El dueño pausó las campañas.']);
      return;
    }
    const biz = await negocio(c.business_id);
    const ctaFinal = c.kind === 'review' ? urlResena(aj.google_review_url) : null;
    if (!biz || !biz.address_line || (c.kind === 'review' && !ctaFinal)) {
      await db.query(`UPDATE rc_campaigns SET status = 'cancelled', cancelled_by = 'system', review_note = $2 WHERE id = $1`,
        [c.id, !biz || !biz.address_line ? 'Falta la dirección del negocio.' : 'Falta el enlace de reseñas en Google.']);
      return;
    }
    const ya = (await db.query(`SELECT count(*)::int n FROM rc_recipients WHERE campaign_id = $1`, [c.id])).rows[0].n;
    if (!ya && !(await armarDestinatarios(c, aj))) {
      await db.query(`UPDATE rc_campaigns SET status = 'cancelled', cancelled_by = 'system',
                             review_note = 'Al salir ya no quedaba nadie a quien enviarle.' WHERE id = $1`, [c.id]);
      return;
    }
    // Lo que quedó a medias si el servidor se reinició: el Idempotency-Key evita duplicados.
    await db.query(`UPDATE rc_recipients SET status = 'queued' WHERE campaign_id = $1 AND status = 'sending'`, [c.id]);
    const replyTo = [biz.email, biz.owner_email].find((x) => x && EMAIL_RE.test(String(x)));
    for (;;) {
      const r = (await db.query(
        `UPDATE rc_recipients SET status = 'sending'
          WHERE id = (SELECT id FROM rc_recipients WHERE campaign_id = $1 AND status = 'queued'
                       ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING *`, [c.id])).rows[0];
      if (!r) break;
      const cl = (await db.query(`SELECT full_name, email_opt_out_at FROM clients WHERE id = $1`, [r.client_id])).rows[0];
      if (!cl || cl.email_opt_out_at) {
        await db.query(`UPDATE rc_recipients SET status = 'failed', error = 'se dio de baja' WHERE id = $1`, [r.id]);
        continue;
      }
      const { html, text } = emailDe({
        c, biz, nombre: primerNombre(cl.full_name),
        ctaUrl: `${SITE()}/api/r/${r.id}`, bajaUrl: `${SITE()}/baja.html?t=${r.id}`,
      });
      try {
        const ref = await resend({
          from: remitente(biz.name), to: [r.email], subject: c.subject, html, text,
          ...(replyTo ? { reply_to: replyTo } : {}),
          headers: { 'List-Unsubscribe': `<${SITE()}/api/public/baja/${r.id}/un-clic>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        }, `rc-${r.id}`);
        await db.query(`UPDATE rc_recipients SET status = 'sent', sent_at = now(), provider_ref = $2, error = NULL WHERE id = $1`, [r.id, ref]);
        await db.query(`UPDATE clients SET mkt_last_sent_at = now()${c.kind === 'review' ? ', review_asked_at = now()' : ''} WHERE id = $1`, [r.client_id]);
      } catch (e) {
        const reintentar = !e.status || e.status === 429 || e.status >= 500;
        await db.query(`UPDATE rc_recipients SET status = $2, error = $3 WHERE id = $1`,
          [r.id, reintentar ? 'queued' : 'failed', String(e.message).slice(0, 300)]);
        if (reintentar) { console.error('recupera envío (se reintenta):', e.message); return; }   // el próximo ciclo sigue
      }
      await new Promise((ok) => setTimeout(ok, Number(process.env.RECUPERA_ESPERA_MS || ESPERA_ENVIO_MS)));
    }
    const n = (await db.query(`SELECT count(*)::int n FROM rc_recipients WHERE campaign_id = $1 AND status = 'sent'`, [c.id])).rows[0].n;
    await db.query(`UPDATE rc_campaigns SET status = 'sent', sent_at = now(), sent_count = $2 WHERE id = $1`, [c.id, n]);
    const detalle = `Salió tu campaña "${NOMBRE_TIPO[c.kind]}" a ${n} ${n === 1 ? 'cliente' : 'clientes'}. En 2 semanas te enseñamos quién volvió.`;
    await alertOwner(c.business_id, null, {
      type: 'system', title: 'Salió tu campaña', body: detalle, template: 'owner_recupera',
      wa: `*Bukéame* — Recupera clientes\n\n${detalle}\n\nMírala en tu panel de Bukéame: Recupera clientes.`,
    });
  }

  let enviando = false;
  async function enviarPendientes() {
    if (enviando || !listo()) return;
    enviando = true;
    try {
      // las que se quedaron a medias (reinicio o Resend caído) y las aprobadas cuya hora llegó
      const { rows } = await db.query(
        `UPDATE rc_campaigns SET status = 'sending'
          WHERE id IN (SELECT id FROM rc_campaigns WHERE (status = 'approved' AND send_at <= now()) OR status = 'sending'
                        ORDER BY send_at NULLS FIRST LIMIT 5)
          RETURNING *`);
      for (const c of rows) await enviarCampana(c).catch((e) => console.error('recupera envío:', e.message));
    } catch (e) { if (e.code !== '42P01') console.error('recupera envío:', e.message); }
    finally { enviando = false; }
  }

  // ---------- Worker: quién volvió (cada hora) ----------
  // Primera cita que el cliente hizo en los 14 días después del email (o de la salida de la
  // campaña, para el grupo de control). Las canceladas no cuentan.
  async function atribuir() {
    await db.query(
      `UPDATE rc_recipients r SET booked_appointment_id = (
         SELECT a.id FROM appointments a
          WHERE a.client_id = r.client_id AND a.business_id = r.business_id
            AND a.created_at > COALESCE(r.sent_at, k.sent_at)
            AND a.created_at <= COALESCE(r.sent_at, k.sent_at) + interval '${VENTANA_DIAS} days'
            AND a.status NOT IN ('cancelled_client','cancelled_business')
          ORDER BY a.created_at LIMIT 1)
         FROM rc_campaigns k
        WHERE k.id = r.campaign_id AND k.sent_at IS NOT NULL AND k.sent_at > now() - interval '${VENTANA_DIAS + 1} days'
          AND r.booked_appointment_id IS NULL AND r.status IN ('sent','held_out')`).catch((e) => {
      if (e.code !== '42P01') throw e;
    });
  }

  // Resultados de las campañas que salieron entre dos fechas (lo que ve el dueño y el informe)
  async function resultados(businessId, desde, hasta) {
    const { rows } = await db.query(
      `SELECT count(DISTINCT k.id)::int campanas,
              count(*) FILTER (WHERE r.status = 'sent')::int enviados,
              count(*) FILTER (WHERE r.status = 'sent' AND r.clicked_at IS NOT NULL)::int clics,
              count(*) FILTER (WHERE r.status = 'sent' AND k.kind = 'review' AND r.clicked_at IS NOT NULL)::int resenas_abiertas,
              count(*) FILTER (WHERE r.status = 'sent' AND k.kind = 'winback' AND a.id IS NOT NULL)::int volvieron,
              COALESCE(sum(a.price_cents) FILTER (WHERE r.status = 'sent' AND k.kind = 'winback'
                       AND (a.status = 'completed' OR (a.status = 'confirmed' AND a.ends_at < now()))), 0)::int cumplidas_cents,
              COALESCE(sum(a.price_cents) FILTER (WHERE r.status = 'sent' AND k.kind = 'winback'
                       AND a.status IN ('confirmed','pending_deposit') AND a.starts_at >= now()), 0)::int por_venir_cents,
              count(*) FILTER (WHERE r.status = 'sent' AND k.kind = 'winback')::int enviados_winback,
              count(*) FILTER (WHERE r.status = 'held_out')::int control,
              count(*) FILTER (WHERE r.status = 'held_out' AND a.id IS NOT NULL)::int control_volvieron
         FROM rc_campaigns k JOIN rc_recipients r ON r.campaign_id = k.id
         LEFT JOIN appointments a ON a.id = r.booked_appointment_id
                                 AND a.status NOT IN ('cancelled_client','cancelled_business','no_show')
        WHERE k.business_id = $1 AND k.sent_at >= $2 AND k.sent_at < $3`, [businessId, desde, hasta]);
    return rows[0];
  }

  // ---------- Worker: informe del mes (día 1, desde las 9 a. m.) ----------
  async function informeMensual() {
    const pr = ahoraPR();
    if (pr.getUTCDate() !== 1 || pr.getUTCHours() < 9) return;
    const finMes = new Date(Date.UTC(pr.getUTCFullYear(), pr.getUTCMonth(), 1, 4));       // 00:00 PR del día 1
    const iniMes = new Date(Date.UTC(pr.getUTCFullYear(), pr.getUTCMonth() - 1, 1, 4));
    const clave = `${iniMes.getUTCFullYear()}-${String(iniMes.getUTCMonth() + 1).padStart(2, '0')}`;
    const { rows } = await db.query(
      `SELECT DISTINCT k.business_id FROM rc_campaigns k
         LEFT JOIN rc_settings s ON s.business_id = k.business_id
        WHERE k.sent_at >= $1 AND k.sent_at < $2 AND s.last_report_month IS DISTINCT FROM $3`, [iniMes, finMes, clave])
      .catch((e) => { if (e.code === '42P01') return { rows: [] }; throw e; });
    for (const { business_id: bid } of rows) {
      try {
        await db.query(
          `INSERT INTO rc_settings (business_id, last_report_month) VALUES ($1,$2)
           ON CONFLICT (business_id) DO UPDATE SET last_report_month = EXCLUDED.last_report_month`, [bid, clave]);
        const x = await resultados(bid, iniMes, finMes);
        const mes = mesPR(new Date(iniMes.getTime() + 864e5));
        const partes = [`En ${mes} salieron ${x.campanas} ${x.campanas === 1 ? 'campaña' : 'campañas'} a ${x.enviados} clientes.`];
        if (x.enviados_winback) partes.push(`${x.volvieron} ${x.volvieron === 1 ? 'cliente volvió' : 'clientes volvieron'} a reservar: ${dinero(x.cumplidas_cents)} en citas cumplidas${x.por_venir_cents ? ` y ${dinero(x.por_venir_cents)} en citas por venir` : ''}.`);
        if (x.resenas_abiertas) partes.push(`${x.resenas_abiertas} abrieron la página para dejarte una reseña.`);
        if (x.control >= 4) partes.push(`Para comparar: de ${x.control} clientes que no recibieron el email, ${x.control_volvieron === 1 ? 'volvió 1' : `volvieron ${x.control_volvieron}`}.`);
        const texto = partes.join(' ');
        await alertOwner(bid, null, {
          type: 'system', title: `Lo que trajo Recupera clientes en ${mes}`, body: texto, template: 'owner_recupera_informe',
          wa: `*Bukéame* — Recupera clientes, ${mes}\n\n${texto}\n\nEl detalle está en tu panel de Bukéame: Recupera clientes.`,
        });
      } catch (e) { console.error('recupera informe:', e.message); }
    }
  }

  // ==========================================================================
  //  PANEL DEL NEGOCIO
  // ==========================================================================
  app.get('/api/recupera', ...PANEL, asyncH(async (req, res) => {
    const bid = req.business.id;
    const [activo, cat, aj, per] = await Promise.all([
      addonActivo(bid),
      db.query(`SELECT price_cents FROM addon_catalog WHERE code::text = $1`, [ADDON]).catch(() => ({ rows: [] })),
      ajustes(bid).catch(() => null),
      periodo(bid),
    ]);
    const out = {
      addon_active: activo, ready: listo(), price_cents: cat.rows[0] ? cat.rows[0].price_cents : 4900,
      settings: aj ? { enabled: aj.enabled, offer_text: aj.offer_text || '', google_review_url: aj.google_review_url || '', lapsed_days: aj.lapsed_days }
                   : { enabled: true, offer_text: '', google_review_url: '', lapsed_days: 45 },
      has_address: !!req.business.address_line,
    };
    if (!aj) return res.json(out);   // sin la migración 36
    const [aud, ahora, enviados, camps, res90] = await Promise.all([
      db.query(
        `SELECT count(*) FILTER (WHERE c.total_visits > 0 OR EXISTS (SELECT 1 FROM appointments a WHERE a.client_id = c.id AND ${VISITA}))::int clientes,
                count(*) FILTER (WHERE c.email IS NOT NULL AND c.email <> '' AND c.email_opt_out_at IS NULL)::int con_email,
                count(*) FILTER (WHERE c.email_opt_out_at IS NOT NULL)::int de_baja
           FROM clients c WHERE c.business_id = $1`, [bid]),
      publico('winback', bid, aj.lapsed_days),
      enviadosDesde(bid, per.inicio),
      db.query(
        `SELECT k.id, k.kind, k.status, k.subject, k.audience_count, k.send_at, k.sent_at, k.sent_count, k.holdout_count, k.capped,
                k.review_note, k.cancelled_by, k.created_at,
                count(r.*) FILTER (WHERE r.status = 'sent' AND r.clicked_at IS NOT NULL)::int clics,
                count(a.id) FILTER (WHERE r.status = 'sent')::int volvieron,
                COALESCE(sum(a.price_cents) FILTER (WHERE r.status = 'sent'), 0)::int citas_cents
           FROM rc_campaigns k
           LEFT JOIN rc_recipients r ON r.campaign_id = k.id
           LEFT JOIN appointments a ON a.id = r.booked_appointment_id AND a.status NOT IN ('cancelled_client','cancelled_business','no_show')
          WHERE k.business_id = $1 AND k.status <> 'rejected'
          GROUP BY k.id ORDER BY k.created_at DESC LIMIT 20`, [bid]),
      resultados(bid, new Date(Date.now() - 90 * 864e5), new Date(Date.now() + 864e5)),
    ]);
    res.json({
      ...out,
      audience: { ...aud.rows[0], no_vuelven: ahora.length },
      usage: { emails_sent: enviados, emails_included: aj.emails_included || 1500, period_end: per.fin.toISOString() },
      results_90d: res90,
      campaigns: camps.rows.map((k) => ({
        ...k, kind_label: NOMBRE_TIPO[k.kind],
        // lo que espera revisión se le enseña al dueño como "preparando", sin el texto aún
        subject: k.status === 'pending_review' ? null : k.subject,
      })),
    });
  }));

  app.put('/api/recupera', ...PANEL, asyncH(async (req, res) => {
    const b = req.body || {};
    const oferta = b.offer_text ? unaLinea(b.offer_text, 140) : null;
    let resena = null;
    if (b.google_review_url) {
      resena = urlResena(b.google_review_url);
      if (!resena) return bad(res, 'Pega el enlace para dejar reseñas que te da Google (empieza con https://g.page o https://search.google.com).');
    }
    const dias = Number(b.lapsed_days);
    if (![30, 45, 60, 90].includes(dias)) return bad(res, 'Escoge 30, 45, 60 o 90 días.');
    const { rows } = await db.query(
      `INSERT INTO rc_settings (business_id, enabled, offer_text, google_review_url, lapsed_days)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (business_id) DO UPDATE SET enabled = EXCLUDED.enabled, offer_text = EXCLUDED.offer_text,
              google_review_url = EXCLUDED.google_review_url, lapsed_days = EXCLUDED.lapsed_days, updated_at = now()
       RETURNING enabled, offer_text, google_review_url, lapsed_days`,
      [req.business.id, b.enabled !== false, oferta, resena, dias]);
    await audit(req, 'recupera.settings', 'business', req.business.id, { enabled: rows[0].enabled });
    res.json({ settings: rows[0] });
  }));

  async function campanaDe(id, businessId) {
    if (!isUuid(id)) return null;
    return (await db.query(`SELECT * FROM rc_campaigns WHERE id = $1 AND ($2::uuid IS NULL OR business_id = $2)`, [id, businessId])).rows[0] || null;
  }
  async function vista(c) {
    const biz = await negocio(c.business_id);
    const { html } = emailDe({ c, biz, nombre: 'María', ctaUrl: '#', bajaUrl: '#' });
    return { subject: c.subject, preheader: c.preheader, html };
  }

  app.get('/api/recupera/campanas/:id/vista', ...PANEL, asyncH(async (req, res) => {
    const c = await campanaDe(req.params.id, req.business.id);
    if (!c || c.status === 'pending_review' || c.status === 'rejected') return bad(res, 'Campaña no encontrada', 404);
    res.json(await vista(c));
  }));

  app.post('/api/recupera/campanas/:id/detener', ...PANEL, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE rc_campaigns SET status = 'cancelled', cancelled_by = 'owner'
        WHERE id = $1 AND business_id = $2 AND status IN ('pending_review','approved') RETURNING id`,
      [isUuid(req.params.id) ? req.params.id : null, req.business.id]);
    if (!rows[0]) return bad(res, 'Esa campaña ya salió o ya no se puede detener.', 409);
    await audit(req, 'recupera.stop', 'campaign', rows[0].id);
    res.json({ ok: true });
  }));

  // ==========================================================================
  //  REVISIÓN DE WIFNIX (admin de plataforma)
  // ==========================================================================
  app.get('/api/admin/recupera', ...ADMIN, asyncH(async (_req, res) => {
    const [pend, rec, tasa, negs] = await Promise.all([
      db.query(
        `SELECT k.*, b.name AS business_name, b.slug FROM rc_campaigns k JOIN businesses b ON b.id = k.business_id
          WHERE k.status = 'pending_review' ORDER BY k.created_at`),
      db.query(
        `SELECT k.id, k.kind, k.status, k.subject, k.audience_count, k.sent_count, k.send_at, k.sent_at, k.edited,
                k.review_note, k.cancelled_by, k.reviewed_at, b.name AS business_name
           FROM rc_campaigns k JOIN businesses b ON b.id = k.business_id
          WHERE k.status <> 'pending_review' ORDER BY COALESCE(k.reviewed_at, k.created_at) DESC LIMIT 30`),
      db.query(
        `SELECT count(*)::int revisadas, count(*) FILTER (WHERE status <> 'rejected' AND edited = false)::int sin_cambios
           FROM (SELECT status, edited FROM rc_campaigns WHERE reviewed_at IS NOT NULL ORDER BY reviewed_at DESC LIMIT 50) x`),
      db.query(
        `SELECT b.id, b.name FROM addons a JOIN businesses b ON b.id = a.business_id AND b.deleted_at IS NULL
          WHERE a.code = $1 AND a.status = 'active'
            AND (a.current_period_end IS NULL OR now() <= a.current_period_end + interval '7 days')
          ORDER BY b.name`, [ADDON]).catch(() => ({ rows: [] })),
    ]);
    const pendientes = [];
    for (const c of pend.rows) pendientes.push({ ...c, kind_label: NOMBRE_TIPO[c.kind], preview: (await vista(c)).html });
    res.json({ ready: listo(), ia: !!claude(), pendientes, recientes: rec.rows, aprobacion: tasa.rows[0], negocios: negs.rows });
  }));

  app.post('/api/admin/recupera/campanas/:id/aprobar', ...ADMIN, asyncH(async (req, res) => {
    const c = await campanaDe(req.params.id, null);
    if (!c || c.status !== 'pending_review') return bad(res, 'Esa campaña ya no está esperando revisión.', 409);
    const b = req.body || {};
    const subject = unaLinea(b.subject != null ? b.subject : c.subject, 70);
    const preheader = unaLinea(b.preheader != null ? b.preheader : c.preheader, 110);
    let body = limpio(b.body != null ? b.body : c.body, 1500);
    const cta = unaLinea(b.cta != null ? b.cta : c.cta, 30);
    if (!subject || !cta || body.length < 30) return bad(res, 'Faltan el asunto, el texto o el botón.');
    if (!body.includes('{{nombre}}')) body = 'Hola {{nombre}},\n\n' + body;
    const d = c.ai_draft || {};
    const edited = subject !== d.subject || preheader !== (d.preheader || '') || body !== d.body || cta !== d.cta;
    const sendAt = b.ahora === true ? new Date() : proximaSalida();
    const { rows } = await db.query(
      `UPDATE rc_campaigns SET status = 'approved', subject = $2, preheader = $3, body = $4, cta = $5, edited = $6,
              reviewed_by = $7, reviewed_at = now(), send_at = $8
        WHERE id = $1 AND status = 'pending_review' RETURNING *`,
      [c.id, subject, preheader, body, cta, edited, req.user.id, sendAt]);
    if (!rows[0]) return bad(res, 'Esa campaña ya no está esperando revisión.', 409);
    await audit(req, 'recupera.approve', 'campaign', c.id, { edited });
    if (b.ahora !== true) {
      const cuando = sendAt.toLocaleString('es-PR', { timeZone: PR_TZ, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
      const detalle = `El ${cuando} sale tu campaña "${NOMBRE_TIPO[c.kind]}" a unos ${c.audience_count} clientes. Si no quieres que salga, detenla antes en tu panel.`;
      await alertOwner(c.business_id, null, {
        type: 'system', title: 'Campaña lista para salir', body: detalle, template: 'owner_recupera',
        wa: `*Bukéame* — Recupera clientes\n\n${detalle}\n\nMírala en tu panel de Bukéame: Recupera clientes.`,
      });
    }
    res.json({ campaign: rows[0] });
  }));

  app.post('/api/admin/recupera/campanas/:id/rechazar', ...ADMIN, asyncH(async (req, res) => {
    const nota = unaLinea((req.body || {}).nota, 300) || null;
    const { rows } = await db.query(
      `UPDATE rc_campaigns SET status = 'rejected', review_note = $2, reviewed_by = $3, reviewed_at = now()
        WHERE id = $1 AND status = 'pending_review' RETURNING id`,
      [isUuid(req.params.id) ? req.params.id : null, nota, req.user.id]);
    if (!rows[0]) return bad(res, 'Esa campaña ya no está esperando revisión.', 409);
    await audit(req, 'recupera.reject', 'campaign', rows[0].id);
    res.json({ ok: true });
  }));

  // Pedirle a la IA otra versión con una indicación ("menciona el especial de barba")
  app.post('/api/admin/recupera/campanas/:id/rehacer', ...ADMIN, asyncH(async (req, res) => {
    const c = await campanaDe(req.params.id, null);
    if (!c || c.status !== 'pending_review') return bad(res, 'Esa campaña ya no está esperando revisión.', 409);
    const nota = unaLinea((req.body || {}).nota, 300);
    const d = await redactar(c.kind, c.facts || {}, nota);
    const { rows } = await db.query(
      `UPDATE rc_campaigns SET subject = $2, preheader = $3, body = $4, cta = $5, ai_model = $6, ai_draft = $7, review_note = $8
        WHERE id = $1 AND status = 'pending_review' RETURNING *`,
      [c.id, d.subject, d.preheader, d.body, d.cta, d.model,
       JSON.stringify({ subject: d.subject, preheader: d.preheader, body: d.body, cta: d.cta }), nota || null]);
    if (!rows[0]) return bad(res, 'Esa campaña ya no está esperando revisión.', 409);
    res.json({ campaign: { ...rows[0], kind_label: NOMBRE_TIPO[c.kind], preview: (await vista(rows[0])).html } });
  }));

  // Preparar una ya (pilotos y pruebas): se salta el calendario, no las reglas.
  app.post('/api/admin/recupera/negocios/:id/preparar', ...ADMIN, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'Negocio inválido');
    const kind = (req.body || {}).kind === 'review' ? 'review' : 'winback';
    if (!(await addonActivo(req.params.id))) return bad(res, 'Ese negocio no tiene el add-on Recupera clientes.', 409);
    const r = await preparar(req.params.id, kind, { forzar: true });
    if (!r.campana) return bad(res, `No se preparó: ${r.motivo}.`, 409);
    res.status(201).json({ campaign: r.campana });
  }));

  // ==========================================================================
  //  PÚBLICO: enlace del email y baja
  // ==========================================================================
  app.get('/api/r/:token', asyncH(async (req, res) => {
    const t = isUuid(req.params.token) ? req.params.token : null;
    const r = t && (await db.query(
      `UPDATE rc_recipients r SET clicked_at = COALESCE(r.clicked_at, now())
         FROM rc_campaigns k, businesses b
        WHERE r.id = $1 AND k.id = r.campaign_id AND b.id = r.business_id AND r.status = 'sent'
        RETURNING k.kind, b.slug, r.business_id`, [t]).catch(() => ({ rows: [] }))).rows[0];
    if (!r) return res.redirect(302, SITE());
    if (r.kind === 'review') {
      const u = urlResena((await ajustes(r.business_id)).google_review_url);
      if (u) return res.redirect(302, u);
    }
    res.redirect(302, `${SITE()}/negocio.html?slug=${encodeURIComponent(r.slug)}&reservar=1&utm_source=email&utm_medium=recupera&utm_campaign=${r.kind}`);
  }));

  async function darDeBaja(token) {
    if (!isUuid(token)) return null;
    const r = (await db.query(
      `SELECT r.id, r.client_id, r.email, b.name FROM rc_recipients r JOIN businesses b ON b.id = r.business_id WHERE r.id = $1`,
      [token])).rows[0];
    if (!r) return null;
    await db.query(`UPDATE clients SET email_opt_out_at = COALESCE(email_opt_out_at, now()) WHERE id = $1`, [r.client_id]);
    await db.query(`UPDATE rc_recipients SET unsubscribed_at = COALESCE(unsubscribed_at, now()) WHERE id = $1`, [r.id]);
    return r;
  }
  const tapado = (e) => { const [u, d] = String(e).split('@'); return `${u.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, u.length - 2)))}@${d || ''}`; };

  app.get('/api/public/baja/:token', codeLimiter, asyncH(async (req, res) => {
    const r = isUuid(req.params.token) && (await db.query(
      `SELECT r.email, b.name, c.email_opt_out_at FROM rc_recipients r JOIN businesses b ON b.id = r.business_id
         JOIN clients c ON c.id = r.client_id WHERE r.id = $1`, [req.params.token])).rows[0];
    if (!r) return bad(res, 'Ese enlace no es válido.', 404);
    res.json({ business_name: r.name, email: tapado(r.email), unsubscribed: !!r.email_opt_out_at });
  }));
  app.post('/api/public/baja/:token', codeLimiter, asyncH(async (req, res) => {
    const r = await darDeBaja(req.params.token);
    if (!r) return bad(res, 'Ese enlace no es válido.', 404);
    res.json({ ok: true, business_name: r.name });
  }));
  // Baja de un clic (RFC 8058): Gmail y Yahoo hacen POST aquí desde el botón "Cancelar suscripción".
  app.post('/api/public/baja/:token/un-clic', asyncH(async (req, res) => {
    await darDeBaja(req.params.token);
    res.status(200).end();
  }));
  app.get('/api/public/baja/:token/un-clic', (req, res) => res.redirect(302, `${SITE()}/baja.html?t=${encodeURIComponent(req.params.token)}`));

  console.log('  ✓ módulo Recupera clientes montado (campañas por email)');

  return {
    planificar: () => planificar().catch((e) => console.error('recupera:', e.message)),
    enviarPendientes,
    atribuir: () => atribuir().catch((e) => console.error('recupera atribución:', e.message)),
    informeMensual: () => informeMensual().catch((e) => console.error('recupera informe:', e.message)),
  };
};

module.exports._prueba = { proximaSalida, urlResena, limpio, plantilla, emailDe, tintaSobre };
