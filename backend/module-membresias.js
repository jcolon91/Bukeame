// ============================================================================
//  BUKEAME API — MEMBRESÍAS (add-on 'memberships', $2.99/mes)
// ----------------------------------------------------------------------------
//  El negocio vende membresías o paquetes prepagados con SUS precios y SUS términos.
//  El cliente paga por adelantado con los métodos del negocio (ATH Móvil automático o
//  al número, tarjeta por su Stripe conectado, o en persona) y el dinero le llega
//  directo: Bukéame solo lleva la cuenta de qué incluye, hasta cuándo vale y cuántas
//  visitas quedan.
//  · Nace 'pending'. Solo un pago confirmado la pone 'active': ATH automático con el
//    monto verificado, el webhook de Stripe, o el negocio que confirma a mano.
//  · Se usa al reservar con su código y el mismo teléfono de la compra. Cada servicio
//    de la cita gasta una visita; si la cita se cancela, la visita vuelve.
//  · Si el negocio deja de pagar el add-on no vende más, pero las que ya vendió se
//    respetan hasta su fecha: el cliente ya pagó.
// ----------------------------------------------------------------------------
//  Negocio  GET|POST /api/memberships/plans · PATCH|DELETE /api/memberships/plans/:id
//           GET /api/memberships · POST /api/memberships (venta en persona)
//           POST /api/memberships/:id/confirm | /cancel | /visits
//  Público  GET|POST /api/public/:slug/memberships · POST /api/public/:slug/memberships/consulta
//           GET  /api/public/:slug/memberships/:id/estado
//           POST /api/public/:slug/memberships/:id/ath/start | /ath/poll | /stripe/checkout | /referencia
//  server.js usa reservar() en la reserva pública y activarPorTarjeta() en el webhook.
// ============================================================================

const crypto = require('crypto');
const athRest = require('./ath-rest');

module.exports.mount = function (app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, isStr, isUuid, isEmail, isPhone, normPhone, audit, notify,
          bookingLimiter, codeLimiter, publicLimiter, sendEmail, sendWhatsApp } = h;
  const APP_URL = (process.env.APP_URL || 'https://bukeame.com').replace(/\/+$/, '');

  // ── Utilidades ────────────────────────────────────────────────────────────
  const ADDON_OK = (alias) => `EXISTS (SELECT 1 FROM addons ad WHERE ad.business_id = ${alias}.id
      AND ad.code = 'memberships' AND ad.status = 'active'
      AND (ad.current_period_end IS NULL OR now() <= ad.current_period_end + interval '7 days'))`;
  // Visitas usadas: las citas vivas o hechas (y las de "no llegó" si así lo dicen sus
  // términos) más lo que el negocio ajustó a mano.
  const USADAS = (m) => `((SELECT COALESCE(sum(ap.membership_visits), 0) FROM appointments ap
      WHERE ap.membership_id = ${m}.id
        AND (ap.status IN ('pending_deposit','confirmed','completed')
             OR (ap.status = 'no_show' AND ${m}.no_show_counts)))::int + ${m}.visits_adjust)`;
  const PERIODO = `CASE WHEN period_unit = 'month' THEN make_interval(months => period_count)
                        ELSE make_interval(days => period_count) END`;
  // La vigencia va por días enteros de Puerto Rico: empieza a las 12:00 a. m. del día en
  // que se activa y ends_at es la medianoche siguiente al último día que vale.
  const HOY_PR = `(date_trunc('day', now() AT TIME ZONE 'America/Puerto_Rico') AT TIME ZONE 'America/Puerto_Rico')`;

  const ALFA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // sin O/0/I/1/L
  function nuevoCodigo(slug) {
    let suf = '';
    for (let i = 0; i < 6; i++) suf += ALFA[crypto.randomInt(ALFA.length)];
    const pre = (slug || 'BK').replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() || 'BK';
    return `${pre}-MEM-${suf}`;
  }
  const dinero = (c) => '$' + (Number(c || 0) / 100).toLocaleString('es-PR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fecha = (d) => new Date(d).toLocaleDateString('es-PR',
    { timeZone: 'America/Puerto_Rico', day: 'numeric', month: 'long', year: 'numeric' });
  const ultimoDia = (ends) => new Date(new Date(ends).getTime() - 1000);   // el último día que vale
  const telTxt = (p) => { const d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : p; };
  const duracion = (u, n) => u === 'month' ? (n === 1 ? '1 mes' : `${n} meses`) : (n === 1 ? '1 día' : `${n} días`);
  const visitasTxt = (v) => v == null ? 'visitas sin límite' : (v === 1 ? '1 visita' : `${v} visitas`);
  const serviciosTxt = (m) => (m.service_names && m.service_names.length) ? m.service_names.join(', ') : 'todos los servicios';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PAY_METHOD = { ath_business: 'ath_movil', ath_manual: 'ath_movil', card: 'card', cash: 'cash' };

  async function addonActivo(bid) {
    const { rows } = await db.query(`SELECT ${ADDON_OK('b')} AS ok FROM businesses b WHERE b.id = $1`, [bid]);
    return !!(rows[0] && rows[0].ok);
  }

  // Cómo se le puede pagar a ESTE negocio, según lo que tiene conectado en Pagos.
  async function opcionesPago(biz) {
    const { rows } = await db.query(
      `SELECT provider, account_ref, COALESCE(config, '{}'::jsonb) AS config FROM payment_providers
        WHERE business_id = $1 AND is_enabled = true AND status = 'connected'`, [biz.id]).catch(() => ({ rows: [] }));
    const by = {};
    for (const r of rows) by[r.provider] = r;
    const out = [];
    if (by.ath_movil_business && by.ath_movil_business.config.ath_public_token)
      out.push({ v: 'ath_business', t: 'ATH Móvil', d: 'Te llega la solicitud de pago a tu app de ATH Móvil.' });
    // Sin el webhook de Connect, el pago con tarjeta nunca activaría la membresía.
    if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET && by.stripe && by.stripe.config.stripe_account_id)
      out.push({ v: 'card', t: 'Tarjeta', d: 'Pagas en la página segura de Stripe.' });
    const athPhone = telTxt((by.ath_movil && by.ath_movil.account_ref) || biz.ath_phone || null);
    if (athPhone)
      out.push({ v: 'ath_manual', t: `ATH Móvil al ${athPhone}`, d: 'Envías el pago y el negocio activa tu membresía.', phone: athPhone });
    if (by.cash || !out.length)
      out.push({ v: 'cash', t: 'En el negocio', d: 'Pagas en persona y el negocio activa tu membresía.', fallback: !out.length && !by.cash });
    return out;
  }

  // Lee y valida una membresía del formulario del negocio. Devuelve { plan } o { error }.
  async function leerPlan(b, bid) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length < 2 || name.length > 80) return { error: 'Ponle un nombre de 2 a 80 letras.' };
    const description = typeof b.description === 'string' ? b.description.trim() : '';
    if (description.length > 300) return { error: 'La descripción es de hasta 300 letras.' };
    if (!Number.isInteger(b.price_cents) || b.price_cents < 100 || b.price_cents > 500000)
      return { error: 'El precio va de $1 a $5,000.' };
    if (!['day', 'month'].includes(b.period_unit)) return { error: 'Escoge si dura días o meses.' };
    const maxN = b.period_unit === 'month' ? 24 : 365;
    if (!Number.isInteger(b.period_count) || b.period_count < 1 || b.period_count > maxN)
      return { error: b.period_unit === 'month' ? 'La duración va de 1 a 24 meses.' : 'La duración va de 1 a 365 días.' };
    let visits = null;
    if (b.visits_included != null) {
      if (!Number.isInteger(b.visits_included) || b.visits_included < 1 || b.visits_included > 999)
        return { error: 'Las visitas van de 1 a 999, o sin límite.' };
      visits = b.visits_included;
    }
    const ids = Array.isArray(b.service_ids) ? [...new Set(b.service_ids.map(String))] : [];
    if (ids.length > 50 || !ids.every(isUuid)) return { error: 'Revisa los servicios que cubre.' };
    if (ids.length) {
      const s = await db.query(`SELECT id FROM services WHERE business_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`, [bid, ids]);
      if (s.rows.length !== ids.length) return { error: 'Uno de los servicios ya no existe. Recarga la página y vuelve a escogerlos.' };
    }
    const terms = typeof b.terms === 'string' ? b.terms.trim() : '';
    if (terms.length < 20) return { error: 'Escribe tus términos (por lo menos una oración): qué pasa si no llega, si se devuelve el dinero, si se puede pasar a otra persona.' };
    if (terms.length > 4000) return { error: 'Los términos son de hasta 4,000 letras.' };
    return { plan: {
      name, description: description || null, price_cents: b.price_cents,
      period_unit: b.period_unit, period_count: b.period_count, visits_included: visits,
      service_ids: ids, no_show_counts: b.no_show_counts !== false, terms,
      is_active: b.is_active !== false,
    } };
  }

  async function nombresServicios(bid, ids) {
    if (!ids || !ids.length) return [];
    const { rows } = await db.query(`SELECT id, name FROM services WHERE business_id = $1 AND id = ANY($2::uuid[])`, [bid, ids]);
    const by = Object.fromEntries(rows.map(r => [r.id, r.name]));
    return ids.map(id => by[id]).filter(Boolean);
  }

  // Lo que se le enseña al cliente de una membresía vendida.
  function vista(m, usadas) {
    const quedan = m.visits_included == null ? null : Math.max(0, m.visits_included - usadas);
    return {
      id: m.id, code: m.code, status: m.status, name: m.name, price_cents: m.price_cents,
      period: duracion(m.period_unit, m.period_count),
      visits_included: m.visits_included, visits_used: usadas, visits_left: quedan,
      all_services: !(m.service_ids && m.service_ids.length), service_names: m.service_names || [],
      starts_at: m.starts_at, ends_at: m.ends_at, last_day: m.ends_at ? ultimoDia(m.ends_at) : null,
      pay_option: m.pay_option,
    };
  }

  // ¿Esta membresía cubre una cita de estos servicios en esta fecha? null = sí; si no, el porqué.
  function evaluar(m, usadas, serviceIds, starts) {
    if (m.status === 'pending') return 'Tu membresía todavía no está activa. El negocio la activa al confirmar tu pago.';
    if (m.status === 'cancelled') return 'Esa membresía está cancelada. Para reservar sin ella, borra el código.';
    if (m.status === 'expired' || !m.ends_at || new Date(m.ends_at) <= new Date())
      return `Tu membresía venció${m.ends_at ? ': valía hasta el ' + fecha(ultimoDia(m.ends_at)) : ''}. Para reservar sin ella, borra el código.`;
    if (starts && starts < new Date(m.starts_at))
      return `Tu membresía empieza el ${fecha(m.starts_at)}. Escoge una fecha desde ese día.`;
    if (starts && starts >= new Date(m.ends_at))
      return `Tu membresía vale hasta el ${fecha(ultimoDia(m.ends_at))}. Escoge una fecha de ese día o antes.`;
    if (serviceIds && m.service_ids && m.service_ids.length) {
      const fuera = serviceIds.filter(id => !m.service_ids.includes(id));
      if (fuera.length) return `Tu membresía cubre: ${serviciosTxt(m)}. Para usarla, reserva solo esos servicios.`;
    }
    if (serviceIds && m.visits_included != null && usadas + serviceIds.length > m.visits_included) {
      const quedan = Math.max(0, m.visits_included - usadas);
      if (quedan === 0) return 'Ya usaste todas las visitas de tu membresía. Para reservar sin ella, borra el código.';
      return `Te ${quedan === 1 ? 'queda 1 visita' : `quedan ${quedan} visitas`} y esta cita usa ${serviceIds.length}. Reserva menos servicios, o borra el código para reservar sin la membresía.`;
    }
    return null;
  }

  // ── Avisos al cliente (fallan suave: nunca tumban el pago ni la activación) ───────
  function emailMembresia(m, bizName, activa) {
    const brand = esc(bizName || 'el negocio');
    const accent = '#0E8074';
    const title = activa ? `Tu membresía de ${brand} ya está activa` : 'Apartamos tu membresía';
    const lead = activa
      ? `Para usarla, reserva en línea y escribe tu código con el mismo teléfono de la compra.`
      : `${brand} la activa cuando confirme tu pago de ${dinero(m.price_cents)}. Te escribimos de nuevo cuando esté lista.`;
    const filas = [
      ['Membresía', esc(m.name)],
      ['Incluye', esc(visitasTxt(m.visits_included) + ' · ' + serviciosTxt(m))],
      activa ? ['Vale', esc(`del ${fecha(m.starts_at)} al ${fecha(ultimoDia(m.ends_at))}`)] : ['Dura', esc(duracion(m.period_unit, m.period_count) + ' desde que se activa')],
      [activa ? 'Pagado' : 'Precio', dinero(m.price_cents)],
    ];
    const tabla = filas.map(([k, v]) => `<tr><td style="padding:7px 0;font-size:13px;color:#7A7464;width:110px;vertical-align:top">${k}</td><td style="padding:7px 0;font-size:13.5px;color:#17150F;font-weight:600">${v}</td></tr>`).join('');
    const boton = activa
      ? `<tr><td style="padding:6px 30px 0 30px"><a href="${esc(APP_URL)}/negocio.html?slug=${encodeURIComponent(m.slug || '')}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:12px">Reservar con mi membresía</a></td></tr>`
      : '';
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>`
      + `<body style="margin:0;padding:0;background:#F1EFE5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1EFE5;padding:32px 16px"><tr><td align="center">`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#fff;border:1px solid #E1DCCD;border-radius:18px;overflow:hidden">`
      + `<tr><td style="height:5px;background:${accent};line-height:5px;font-size:5px">&nbsp;</td></tr>`
      + `<tr><td style="padding:24px 30px 6px 30px"><div style="font-size:20px;font-weight:800;color:#17150F">Buk<span style="color:${accent}">é</span>ame · Membresía</div><div style="font-size:13px;color:#7A7464;margin-top:2px">${brand}</div></td></tr>`
      + `<tr><td style="padding:6px 30px 0 30px"><h1 style="margin:0 0 6px;font-size:18px;font-weight:800;color:#17150F">${title}</h1><p style="margin:0 0 14px;font-size:14px;color:#5E594B;line-height:1.6">${lead}</p></td></tr>`
      + `<tr><td style="padding:0 30px 4px 30px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBFAF5;border:1px dashed ${accent};border-radius:14px"><tr><td style="padding:18px;text-align:center">`
      + `<div style="font-size:12px;color:#7A7464;letter-spacing:.06em;text-transform:uppercase">Tu código</div>`
      + `<div style="font-size:28px;font-weight:800;letter-spacing:2px;color:${accent};font-family:Consolas,monospace;margin:6px 0">${esc(m.code)}</div>`
      + `</td></tr></table></td></tr>`
      + `<tr><td style="padding:12px 30px 0 30px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${tabla}</table></td></tr>`
      + boton
      + `<tr><td style="padding:18px 30px 24px 30px"><p style="margin:0;font-size:11px;color:#A39C88;line-height:1.5">Los términos de esta membresía son de ${brand}. El pago le llega directo a ${brand}: para devoluciones o cambios, habla con el negocio.<br>Bukéame · bukeame.com</p></td></tr>`
      + `</table></td></tr></table></body></html>`;
    const text = `${activa ? `Tu membresía de ${bizName} ya está activa` : 'Apartamos tu membresía'}\n`
      + `Código: ${m.code}\nMembresía: ${m.name}\nIncluye: ${visitasTxt(m.visits_included)} · ${serviciosTxt(m)}\n`
      + (activa ? `Vale del ${fecha(m.starts_at)} al ${fecha(ultimoDia(m.ends_at))}\n\nPara usarla, reserva en ${APP_URL}/negocio.html?slug=${encodeURIComponent(m.slug || '')} y escribe tu código.`
                : `\n${bizName} la activa cuando confirme tu pago de ${dinero(m.price_cents)}.`)
      + `\n\nLos términos son de ${bizName}. El pago le llega directo al negocio.`;
    const subject = activa ? `Tu membresía de ${bizName} está activa (${m.code})` : `Apartamos tu membresía de ${bizName}`;
    return { subject, text, html };
  }

  function avisarCliente(m, biz, activa) {
    const mm = { ...m, slug: biz.slug };
    if (m.email && isEmail(m.email) && sendEmail) {
      const e = emailMembresia(mm, biz.name, activa);
      sendEmail(m.email, e.subject, e.text, e.html).catch(err => console.error('membresía email:', err.message));
    }
    if (activa && m.phone && sendWhatsApp) {
      const txt = `✅ *${biz.name}*\nTu membresía *${m.name}* ya está activa.\n\n`
        + `🎟 Código: ${m.code}\n🗓 Vale del ${fecha(m.starts_at)} al ${fecha(ultimoDia(m.ends_at))}\n💈 Incluye: ${visitasTxt(m.visits_included)} · ${serviciosTxt(m)}\n\n`
        + `Para usarla, reserva aquí y escribe tu código: ${APP_URL}/negocio.html?slug=${encodeURIComponent(biz.slug)}`;
      sendWhatsApp(m.phone, txt).catch(err => console.error('membresía whatsapp:', err.message));
    }
  }

  // ── Activar: el ÚNICO camino de 'pending' a 'active' ───────────────────────────
  // Si el cliente ya tiene una igual vigente (renovó antes de tiempo), la nueva
  // arranca cuando termine la otra. Registra el pago (kind 'membership') para la
  // contabilidad del negocio. Idempotente: si ya no está 'pending', no hace nada.
  async function activar(id, opt = {}) {
    const cx = await db.connect();
    let m;
    try {
      await cx.query('BEGIN');
      const r = await cx.query(
        `SELECT * FROM memberships WHERE id = $1 ${opt.businessId ? 'AND business_id = $2' : ''} FOR UPDATE`,
        opt.businessId ? [id, opt.businessId] : [id]);
      m = r.rows[0];
      if (!m) { await cx.query('ROLLBACK'); return { missing: true }; }
      if (m.status !== 'pending') { await cx.query('ROLLBACK'); return { already: m.status, membership: m }; }
      const hoy = await cx.query(`SELECT ${HOY_PR} AS d`);
      let starts = new Date(hoy.rows[0].d);
      // Renovó antes de tiempo: va en fila detrás de la que tiene, pero solo si a esa le
      // quedan visitas. Si ya las gastó todas, la nueva sirve desde hoy.
      if (m.plan_id) {
        const prev = await cx.query(
          `SELECT p.ends_at, p.visits_included, ${USADAS('p')} AS usadas FROM memberships p
            WHERE p.business_id = $1 AND p.phone = $2 AND p.plan_id = $3 AND p.status = 'active'
              AND p.ends_at > now() AND p.id <> $4`, [m.business_id, m.phone, m.plan_id, m.id]);
        for (const p of prev.rows)
          if ((p.visits_included == null || p.usadas < p.visits_included) && new Date(p.ends_at) > starts)
            starts = new Date(p.ends_at);
      }
      const method = ['ath_movil', 'card', 'cash'].includes(opt.method) ? opt.method : (PAY_METHOD[m.pay_option] || 'cash');
      const ref = isStr(opt.ref, 200) ? opt.ref : (m.pay_ref || null);
      const p = await cx.query(
        `INSERT INTO payments (business_id, client_id, kind, method, amount_cents, status, paid_at, external_ref)
         VALUES ($1,$2,'membership',$3::payment_method,$4,'paid',now(),$5) RETURNING id`,
        [m.business_id, m.client_id, method, m.price_cents, ref]);
      const u = await cx.query(
        `UPDATE memberships SET status = 'active', activated_at = now(), starts_at = $2,
                ends_at = $2::timestamptz + ${PERIODO}, pay_ref = $3, payment_id = $4
          WHERE id = $1 RETURNING *`, [m.id, starts, ref, p.rows[0].id]);
      if (m.client_id)
        await cx.query(`UPDATE clients SET total_spent_cents = total_spent_cents + $2 WHERE id = $1`, [m.client_id, m.price_cents]);
      await cx.query('COMMIT');
      m = u.rows[0];
    } catch (e) { await cx.query('ROLLBACK').catch(() => {}); throw e; }
    finally { cx.release(); }

    const bz = await db.query(`SELECT name, slug FROM businesses WHERE id = $1`, [m.business_id]);
    const biz = bz.rows[0] || { name: '', slug: '' };
    if (!opt.byBusiness)
      await notify(m.business_id, 'payment', 'Membresía pagada',
        `${m.buyer_name} · ${m.name} · ${dinero(m.price_cents)}`, { membership_id: m.id }).catch(() => {});
    avisarCliente(m, biz, true);
    return { activated: true, membership: m };
  }

  // Entró un pago para una membresía que ya no esperaba pago. Si estaba cancelada o
  // vencida, el negocio la registra o devuelve el dinero; si ya estaba activa con otro
  // pago (dos pestañas, dos intentos), es un cobro doble y hay que devolverlo.
  async function pagoSobrante(m, via, ref) {
    if (!m) return;
    if (m.status === 'active') {
      if (!ref || ref === m.pay_ref) return;   // el mismo pago avisado dos veces
      await notify(m.business_id, 'payment', 'Pago doble de una membresía',
        `${m.buyer_name} pagó otra vez ${dinero(m.price_cents)} con ${via} por "${m.name}", que ya estaba activa (referencia ${ref}). Devuélvele ese segundo pago.`,
        { membership_id: m.id }).catch(() => {});
      return;
    }
    await notify(m.business_id, 'payment', 'Pago de una membresía cancelada',
      `${m.buyer_name} pagó ${dinero(m.price_cents)} con ${via} por "${m.name}", pero esa membresía ya estaba cancelada. Regístrala con "Vender en persona" o devuélvele el dinero.`,
      { membership_id: m.id }).catch(() => {});
  }

  // Lo llama el webhook de Stripe Connect (server.js) con metadata kind='membership'.
  // Ese webhook recibe los eventos de TODAS las cuentas conectadas, así que la metadata
  // sola no prueba nada: el pago tiene que venir de la cuenta Stripe de este negocio,
  // por el precio exacto, en dólares y ya cobrado.
  async function activarPorTarjeta(id, info = {}) {
    if (!isUuid(id) || !info.paid) return;   // pago diferido: llega luego como payment_intent.succeeded
    const { rows } = await db.query(
      `SELECT m.id, m.business_id, m.price_cents, m.pay_option, pp.config->>'stripe_account_id' AS acct
         FROM memberships m
         LEFT JOIN payment_providers pp ON pp.business_id = m.business_id AND pp.provider = 'stripe'
        WHERE m.id = $1`, [id]);
    const m = rows[0];
    if (!m) return;
    if (!info.account || !m.acct || info.account !== m.acct) {
      console.error('stripe membresía: el pago no viene de la cuenta del negocio', id, info.account);
      return;
    }
    if (m.pay_option !== 'card' || info.amount !== m.price_cents || info.currency !== 'usd') {
      console.error('stripe membresía: el pago no cuadra', id, info.amount, info.currency);
      await notify(m.business_id, 'payment', 'Pago con tarjeta que no cuadra',
        `Llegó un pago con tarjeta de ${dinero(info.amount)} para una membresía de ${dinero(m.price_cents)} y no la activamos. Revísalo en tu Stripe.`,
        { membership_id: m.id }).catch(() => {});
      return;
    }
    const r = await activar(id, { method: 'card', ref: info.ref });
    if (r.already) await pagoSobrante(r.membership, 'tarjeta', info.ref);
  }

  // ── Reserva pública: aparta las visitas DENTRO de la transacción de la cita ─────
  // cx = cliente de la transacción (server.js). FOR UPDATE: dos reservas a la vez no
  // pueden gastar la misma última visita. Lanza un error con .membresia si no aplica.
  async function reservar(cx, o) {
    const no = (msg, status = 400) => Object.assign(new Error(msg), { membresia: true, status });
    const code = String(o.code || '').trim().toUpperCase();
    if (!code || code.length > 40) throw no('Escribe el código de tu membresía.');
    const r = await cx.query(`SELECT * FROM memberships WHERE business_id = $1 AND code = $2 FOR UPDATE`, [o.businessId, code]);
    const m = r.rows[0];
    if (!m || m.phone !== o.phoneN)
      throw no('No encontramos esa membresía con ese teléfono. Revisa el código y usa el teléfono con que la compraste.', 404);
    const u = await cx.query(`SELECT ${USADAS('m')} AS n FROM memberships m WHERE m.id = $1`, [m.id]);
    const porque = evaluar(m, u.rows[0].n, o.serviceIds, o.starts);
    if (porque) throw no(porque, 409);
    const usadas = u.rows[0].n + o.serviceIds.length;
    return { id: m.id, visits: o.serviceIds.length, name: m.name,
             visits_left: m.visits_included == null ? null : Math.max(0, m.visits_included - usadas) };
  }

  // ── Trabajo de cada hora: vencer, soltar las que nunca se pagaron y recordar ───
  async function revisar() {
    await db.query(`UPDATE memberships SET status = 'expired' WHERE status = 'active' AND ends_at <= now()`);
    await db.query(`UPDATE memberships SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'Nunca se confirmó el pago'
                     WHERE status = 'pending' AND created_at < now() - interval '7 days'`);
    // Recordatorio de renovación: 5 días antes (2 si dura menos de 2 semanas; ninguno si
    // dura menos de 4 días). Solo si el negocio sigue vendiendo membresías (si no, no hay
    // dónde renovar) y si el cliente no compró ya otra igual que dura más.
    const { rows } = await db.query(
      `SELECT m.*, b.name AS biz_name, b.slug AS biz_slug
         FROM memberships m JOIN businesses b ON b.id = m.business_id AND b.deleted_at IS NULL
        WHERE m.status = 'active' AND m.reminder_sent_at IS NULL AND m.ends_at > now()
          AND NOT (m.period_unit = 'day' AND m.period_count < 4)
          AND m.ends_at <= now() + CASE WHEN (m.period_unit = 'day' AND m.period_count < 14) THEN interval '2 days' ELSE interval '5 days' END
          AND ${ADDON_OK('b')}
          AND NOT EXISTS (SELECT 1 FROM memberships n WHERE n.business_id = m.business_id AND n.phone = m.phone
                            AND n.plan_id = m.plan_id AND n.id <> m.id AND n.status = 'active' AND n.ends_at > m.ends_at)
        LIMIT 200`);
    for (const m of rows) {
      const claim = await db.query(`UPDATE memberships SET reminder_sent_at = now() WHERE id = $1 AND reminder_sent_at IS NULL`, [m.id]);
      if (!claim.rowCount) continue;
      const link = `${APP_URL}/membresia.html?slug=${encodeURIComponent(m.biz_slug)}`;
      if (sendWhatsApp && m.phone)
        sendWhatsApp(m.phone, `⏳ *${m.biz_name}*\nTu membresía *${m.name}* vale hasta el ${fecha(ultimoDia(m.ends_at))}.\n\nSi quieres seguir, renuévala aquí: ${link}\nLa nueva empieza cuando termine esta, así que no pierdes días.`)
          .catch(e => console.error('membresía recordatorio:', e.message));
      if (sendEmail && m.email && isEmail(m.email))
        sendEmail(m.email, `Tu membresía de ${m.biz_name} vale hasta el ${fecha(ultimoDia(m.ends_at))}`,
          `Tu membresía "${m.name}" en ${m.biz_name} vale hasta el ${fecha(ultimoDia(m.ends_at))}.\n\nSi quieres seguir, renuévala aquí: ${link}\nLa nueva empieza cuando termine esta, así que no pierdes días.\n\nBukéame · bukeame.com`)
          .catch(e => console.error('membresía recordatorio:', e.message));
    }
  }

  // ==========================================================================
  //  NEGOCIO
  // ==========================================================================
  const PLAN_COLS = `id, name, description, price_cents, period_unit, period_count, visits_included,
                     service_ids, no_show_counts, terms, is_active, sort_order, created_at`;

  app.get('/api/memberships/plans', authRequired, businessScope, asyncH(async (req, res) => {
    const bid = req.business.id;
    const [plans, services, activo, opciones] = await Promise.all([
      db.query(`SELECT ${PLAN_COLS},
                       (SELECT count(*)::int FROM memberships m WHERE m.plan_id = p.id AND m.status = 'active') AS active_count
                  FROM membership_plans p WHERE business_id = $1 AND archived_at IS NULL
                 ORDER BY sort_order, price_cents`, [bid]),
      // También las pausadas: si una membresía cubre una, editarla no debe soltarla en silencio.
      db.query(`SELECT id, name, price_cents, is_active FROM services WHERE business_id = $1 AND deleted_at IS NULL ORDER BY is_active DESC, sort_order, name`, [bid]),
      addonActivo(bid),
      opcionesPago(req.business),
    ]);
    res.json({
      addon_active: activo, plans: plans.rows, services: services.rows,
      payment_options: opciones.map(o => o.v),
      pay_fallback: opciones.some(o => o.fallback),   // sin métodos conectados: solo se aparta y se paga en persona
      cancellation_hours: req.business.cancellation_hours,
      public_url: `${APP_URL}/membresia.html?slug=${encodeURIComponent(req.business.slug)}`,
    });
  }));

  app.post('/api/memberships/plans', authRequired, businessScope, asyncH(async (req, res) => {
    const bid = req.business.id;
    if (!(await addonActivo(bid))) return bad(res, 'Activa el add-on de Membresías en Mi cuenta para vender membresías.', 403);
    const c = await db.query(`SELECT count(*)::int n FROM membership_plans WHERE business_id = $1 AND archived_at IS NULL`, [bid]);
    if (c.rows[0].n >= 20) return bad(res, 'Puedes tener hasta 20 membresías. Borra alguna que ya no uses.', 409);
    const { plan, error } = await leerPlan(req.body || {}, bid);
    if (error) return bad(res, error);
    const { rows } = await db.query(
      `INSERT INTO membership_plans (business_id, name, description, price_cents, period_unit, period_count,
          visits_included, service_ids, no_show_counts, terms, is_active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::uuid[],$9,$10,$11,$12) RETURNING ${PLAN_COLS}`,
      [bid, plan.name, plan.description, plan.price_cents, plan.period_unit, plan.period_count,
       plan.visits_included, plan.service_ids, plan.no_show_counts, plan.terms, plan.is_active, c.rows[0].n]);
    await audit(req, 'membership_plan.create', 'membership_plan', rows[0].id, { price_cents: plan.price_cents });
    res.status(201).json({ plan: rows[0] });
  }));

  // Cambiar una membresía NO cambia las ya vendidas: cada una guardó lo que se compró.
  app.patch('/api/memberships/plans/:id', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'No encontramos esa membresía.');
    const bid = req.business.id;
    const cur = await db.query(`SELECT ${PLAN_COLS} FROM membership_plans WHERE id = $1 AND business_id = $2 AND archived_at IS NULL`, [req.params.id, bid]);
    if (!cur.rows[0]) return bad(res, 'No encontramos esa membresía.', 404);
    const body = { ...cur.rows[0], ...(req.body || {}) };
    // Si no mandan los servicios (pausar, cambiar el precio…), se quedan los que tenía,
    // menos los que el negocio ya borró. Si los borró todos, que escoja otros: quedarse
    // vacía la volvería "todos los servicios" sin que nadie lo decida.
    if (!Array.isArray((req.body || {}).service_ids) && cur.rows[0].service_ids.length) {
      const vivos = await db.query(`SELECT id FROM services WHERE business_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
        [bid, cur.rows[0].service_ids]);
      body.service_ids = cur.rows[0].service_ids.filter(id => vivos.rows.some(v => v.id === id));
      if (!body.service_ids.length) return bad(res, 'Los servicios que cubría esta membresía ya no existen. Edítala y escoge otros.', 409);
    }
    // Volver a ponerla a la venta exige el add-on; pausarla o editarla, no.
    if (body.is_active !== false && !cur.rows[0].is_active && !(await addonActivo(bid)))
      return bad(res, 'Activa el add-on de Membresías en Mi cuenta para volver a venderla.', 403);
    const { plan, error } = await leerPlan(body, bid);
    if (error) return bad(res, error);
    const { rows } = await db.query(
      `UPDATE membership_plans SET name=$3, description=$4, price_cents=$5, period_unit=$6, period_count=$7,
              visits_included=$8, service_ids=$9::uuid[], no_show_counts=$10, terms=$11, is_active=$12, updated_at=now()
        WHERE id = $1 AND business_id = $2 RETURNING ${PLAN_COLS}`,
      [req.params.id, bid, plan.name, plan.description, plan.price_cents, plan.period_unit, plan.period_count,
       plan.visits_included, plan.service_ids, plan.no_show_counts, plan.terms, plan.is_active]);
    await audit(req, 'membership_plan.update', 'membership_plan', req.params.id);
    res.json({ plan: rows[0] });
  }));

  // Borrar = sacarla de la venta para siempre. Las vendidas siguen igual.
  app.delete('/api/memberships/plans/:id', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'No encontramos esa membresía.');
    const { rowCount } = await db.query(
      `UPDATE membership_plans SET archived_at = now(), is_active = false, updated_at = now()
        WHERE id = $1 AND business_id = $2 AND archived_at IS NULL`, [req.params.id, req.business.id]);
    if (!rowCount) return bad(res, 'No encontramos esa membresía.', 404);
    await audit(req, 'membership_plan.archive', 'membership_plan', req.params.id);
    res.json({ ok: true });
  }));

  // Las vendidas. ?status=pending|active|ended ; ?q= busca por nombre, teléfono o código.
  app.get('/api/memberships', authRequired, businessScope, asyncH(async (req, res) => {
    const vals = [req.business.id];
    let where = '';
    const st = String(req.query.status || '');
    if (st === 'pending' || st === 'active') { vals.push(st); where += ` AND m.status = $${vals.length}`; }
    else if (st === 'ended') where += ` AND m.status IN ('expired','cancelled')`;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
    if (q) {
      vals.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%', q.replace(/\D/g, '') || '§');
      where += ` AND (m.buyer_name ILIKE $${vals.length - 1} OR m.code ILIKE $${vals.length - 1} OR m.phone LIKE '%' || $${vals.length} || '%')`;
    }
    const { rows } = await db.query(
      `SELECT m.id, m.code, m.status, m.buyer_name, m.phone, m.email, m.source, m.name, m.price_cents,
              m.period_unit, m.period_count, m.visits_included, m.service_names, m.no_show_counts,
              m.pay_option, m.pay_ref, m.starts_at, m.ends_at, m.ends_at - interval '1 second' AS last_day,
              m.activated_at, m.cancelled_at, m.cancel_reason,
              m.created_at, m.visits_adjust, ${USADAS('m')} AS visits_used,
              (SELECT count(*)::int FROM appointments ap WHERE ap.membership_id = m.id
                  AND ap.status IN ('pending_deposit','confirmed') AND ap.starts_at > now()) AS upcoming
         FROM memberships m WHERE m.business_id = $1 ${where}
        ORDER BY (m.status = 'pending') DESC, m.created_at DESC LIMIT 200`, vals);
    const counts = await db.query(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int pending,
              count(*) FILTER (WHERE status = 'active')::int active,
              COALESCE(sum(price_cents) FILTER (WHERE status IN ('active','expired') AND activated_at >= date_trunc('month', now())), 0)::int sold_month_cents
         FROM memberships WHERE business_id = $1`, [req.business.id]);
    res.json({ memberships: rows, ...counts.rows[0] });
  }));

  // Venta en persona: el negocio ya cobró, así que nace activa.
  app.post('/api/memberships', authRequired, businessScope, asyncH(async (req, res) => {
    const bid = req.business.id;
    if (!(await addonActivo(bid))) return bad(res, 'Activa el add-on de Membresías en Mi cuenta para vender membresías.', 403);
    const { plan_id, buyer_name, phone, email, method } = req.body || {};
    if (!isUuid(plan_id)) return bad(res, 'Escoge la membresía.');
    if (!isStr(buyer_name, 120) || buyer_name.trim().length < 2) return bad(res, 'Escribe el nombre del cliente.');
    if (!isPhone(phone)) return bad(res, 'Escribe el teléfono del cliente (10 dígitos). Con ese teléfono y el código usa su membresía.');
    if (email && !isEmail(email)) return bad(res, 'Revisa el email del cliente.');
    if (!['cash', 'ath_movil', 'card'].includes(method)) return bad(res, 'Escoge cómo te pagó.');
    const r = await crearMembresia({ biz: req.business, planId: plan_id, buyerName: buyer_name.trim(), phoneN: normPhone(phone),
      email: email ? email.toLowerCase() : null, payOption: method === 'card' ? 'card' : (method === 'cash' ? 'cash' : 'ath_manual'),
      source: 'business', anyPlan: true });
    if (r.error) return bad(res, r.error, r.status || 400);
    const a = await activar(r.membership.id, { businessId: bid, method, byBusiness: true });
    await audit(req, 'membership.sell', 'membership', r.membership.id, { price_cents: r.membership.price_cents, method });
    res.status(201).json({ membership: a.membership });
  }));

  app.post('/api/memberships/:id/confirm', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'No encontramos esa membresía.');
    const method = (req.body || {}).method;
    const r = await activar(req.params.id, { businessId: req.business.id, method, byBusiness: true });
    if (r.missing) return bad(res, 'No encontramos esa membresía.', 404);
    if (r.already) return bad(res, r.already === 'active' ? 'Esa membresía ya estaba activa.' : 'Esa membresía ya no está esperando pago. Si te pagó, regístrala con "Vender en persona".', 409);
    await audit(req, 'membership.confirm', 'membership', req.params.id, { method: method || null });
    res.json({ ok: true, membership: r.membership });
  }));

  // Cancelar: deja de valer desde ya. Si hay que devolver dinero, lo hace el negocio
  // por donde le pagaron (Bukéame nunca tuvo ese dinero).
  app.post('/api/memberships/:id/cancel', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'No encontramos esa membresía.');
    const reason = isStr((req.body || {}).reason, 200) ? req.body.reason.trim() : null;
    const { rows } = await db.query(
      `UPDATE memberships SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3
        WHERE id = $1 AND business_id = $2 AND status IN ('pending','active') RETURNING id, status`,
      [req.params.id, req.business.id, reason]);
    if (!rows[0]) return bad(res, 'Esa membresía ya no está activa.', 404);
    await audit(req, 'membership.cancel', 'membership', req.params.id, { reason });
    res.json({ ok: true });
  }));

  // Descontar (+1) o devolver (-1) una visita a mano: una visita sin cita en Bukéame, o
  // perdonar un "no llegó".
  app.post('/api/memberships/:id/visits', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'No encontramos esa membresía.');
    const delta = (req.body || {}).delta;
    if (delta !== 1 && delta !== -1) return bad(res, 'No pudimos cambiar las visitas. Intenta de nuevo.');
    const cx = await db.connect();
    try {
      await cx.query('BEGIN');
      const r = await cx.query(
        `SELECT m.*, ${USADAS('m')} AS usadas FROM memberships m WHERE m.id = $1 AND m.business_id = $2 FOR UPDATE`,
        [req.params.id, req.business.id]);
      const m = r.rows[0];
      if (!m) { await cx.query('ROLLBACK'); return bad(res, 'No encontramos esa membresía.', 404); }
      if (m.status !== 'active') { await cx.query('ROLLBACK'); return bad(res, 'Solo se ajustan las membresías activas.', 409); }
      if (delta === 1 && m.visits_included != null && m.usadas >= m.visits_included) {
        await cx.query('ROLLBACK'); return bad(res, 'Ya usó todas las visitas.', 409);
      }
      if (delta === -1 && m.usadas <= 0) { await cx.query('ROLLBACK'); return bad(res, 'No tiene visitas usadas que devolver.', 409); }
      await cx.query(`UPDATE memberships SET visits_adjust = visits_adjust + $2 WHERE id = $1`, [m.id, delta]);
      await cx.query('COMMIT');
      await audit(req, 'membership.visits', 'membership', m.id, { delta });
      res.json({ ok: true, visits_used: m.usadas + delta });
    } catch (e) { await cx.query('ROLLBACK').catch(() => {}); throw e; }
    finally { cx.release(); }
  }));

  // ==========================================================================
  //  PÚBLICO
  // ==========================================================================
  async function negocioPublico(slug) {
    const { rows } = await db.query(
      `SELECT b.id, b.slug, b.name, b.ath_phone, ${ADDON_OK('b')} AS addon_ok
         FROM businesses b WHERE b.slug = $1 AND b.deleted_at IS NULL`, [slug]);
    return rows[0] || null;
  }

  // Crea la fila 'pending' (y el cliente en el CRM). La comparten la compra en línea
  // y la venta en persona. anyPlan: el negocio puede vender una pausada.
  async function crearMembresia(o) {
    const { rows: pl } = await db.query(
      `SELECT * FROM membership_plans WHERE id = $1 AND business_id = $2 AND archived_at IS NULL
          ${o.anyPlan ? '' : 'AND is_active'}`, [o.planId, o.biz.id]);
    const plan = pl[0];
    if (!plan) return { error: 'Esa membresía ya no está a la venta.', status: 404 };
    const cl = await db.query(
      `INSERT INTO clients (business_id, full_name, phone, email) VALUES ($1,$2,$3,$4)
       ON CONFLICT (business_id, phone)
       DO UPDATE SET email = COALESCE(EXCLUDED.email, clients.email)
       RETURNING id, is_blocked`, [o.biz.id, o.buyerName, o.phoneN, o.email]);
    if (cl.rows[0].is_blocked && o.source === 'online') return { error: 'No es posible comprar en este negocio.', status: 403 };
    const names = await nombresServicios(o.biz.id, plan.service_ids);
    for (let i = 0; i < 6; i++) {
      try {
        const { rows } = await db.query(
          `INSERT INTO memberships (business_id, plan_id, client_id, code, buyer_name, phone, email, source,
              name, price_cents, period_unit, period_count, visits_included, service_ids, service_names,
              no_show_counts, terms, terms_accepted_at, pay_option)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::uuid[],$15::text[],$16,$17,$18,$19)
           RETURNING *`,
          [o.biz.id, plan.id, cl.rows[0].id, nuevoCodigo(o.biz.slug), o.buyerName, o.phoneN, o.email, o.source,
           plan.name, plan.price_cents, plan.period_unit, plan.period_count, plan.visits_included,
           plan.service_ids, names, plan.no_show_counts, plan.terms,
           o.source === 'online' ? new Date() : null, o.payOption]);
        return { membership: rows[0] };
      } catch (e) { if (e.code !== '23505') throw e; }   // código repetido: otro intento
    }
    throw new Error('No se pudo generar un código único');
  }

  app.get('/api/public/:slug/memberships', publicLimiter, asyncH(async (req, res) => {
    const biz = await negocioPublico(req.params.slug);
    if (!biz) return bad(res, 'No encontramos ese negocio.', 404);
    const business = { name: biz.name, slug: biz.slug };
    if (!biz.addon_ok) return res.json({ business, plans: [], payment_options: [] });
    const [plans, opciones] = await Promise.all([
      db.query(`SELECT id, name, description, price_cents, period_unit, period_count, visits_included,
                       service_ids, no_show_counts, terms
                  FROM membership_plans WHERE business_id = $1 AND archived_at IS NULL AND is_active
                 ORDER BY sort_order, price_cents`, [biz.id]),
      opcionesPago(biz),
    ]);
    const allIds = [...new Set(plans.rows.flatMap(p => p.service_ids || []))];
    const svc = allIds.length
      ? await db.query(`SELECT id, name FROM services WHERE business_id = $1 AND id = ANY($2::uuid[])`, [biz.id, allIds])
      : { rows: [] };
    const nom = Object.fromEntries(svc.rows.map(s => [s.id, s.name]));
    res.json({
      business,
      plans: plans.rows.map(p => ({
        id: p.id, name: p.name, description: p.description, price_cents: p.price_cents,
        period: duracion(p.period_unit, p.period_count), visits_included: p.visits_included,
        all_services: !(p.service_ids && p.service_ids.length),
        service_names: (p.service_ids || []).map(id => nom[id]).filter(Boolean),
        no_show_counts: p.no_show_counts, terms: p.terms,
      })),
      payment_options: opciones.map(({ v, t, d }) => ({ v, t, d })),
    });
  }));

  app.post('/api/public/:slug/memberships', bookingLimiter, asyncH(async (req, res) => {
    const { plan_id, buyer_name, phone, email, accept_terms, pay_option } = req.body || {};
    if (!isUuid(plan_id)) return bad(res, 'Escoge una membresía.');
    if (!isStr(buyer_name, 120) || buyer_name.trim().length < 2) return bad(res, 'Escribe tu nombre.');
    if (!isPhone(phone)) return bad(res, 'Escribe tu teléfono de 10 dígitos. Con ese teléfono y tu código usas la membresía.');
    if (!isEmail(email)) return bad(res, 'Escribe tu email: ahí te llega el recibo con tu código.');
    if (accept_terms !== true) return bad(res, 'Para comprarla, acepta los términos del negocio.');
    const biz = await negocioPublico(req.params.slug);
    if (!biz) return bad(res, 'No encontramos ese negocio.', 404);
    if (!biz.addon_ok) return bad(res, 'Este negocio no está vendiendo membresías ahora mismo.', 404);
    const opciones = await opcionesPago(biz);
    const op = opciones.find(x => x.v === pay_option);
    if (!op) return bad(res, 'Escoge cómo vas a pagar.');
    const phoneN = normPhone(phone);
    // Abuso: pocas apartadas sin pagar por teléfono y día.
    const cap = await db.query(
      `SELECT count(*)::int n FROM memberships WHERE business_id = $1 AND phone = $2 AND status = 'pending'
          AND created_at > now() - interval '1 day'`, [biz.id, phoneN]);
    if (cap.rows[0].n >= 3) return bad(res, 'Ya tienes membresías esperando pago en este negocio. Espera a que el negocio las active.', 429);
    const r = await crearMembresia({ biz, planId: plan_id, buyerName: buyer_name.trim(), phoneN,
      email: email.toLowerCase(), payOption: op.v, source: 'online' });
    if (r.error) return bad(res, r.error, r.status || 400);
    const m = r.membership;
    // Los pagos automáticos avisan al entrar; los manuales, ya, para que el negocio confirme.
    if (op.v === 'ath_manual' || op.v === 'cash') {
      await notify(biz.id, 'payment', 'Membresía por confirmar',
        `${m.buyer_name} · ${m.name} · ${dinero(m.price_cents)} · ${op.v === 'cash' ? 'paga en persona' : 'paga por ATH al número'}. Confírmala en Membresías cuando recibas el pago.`,
        { membership_id: m.id }).catch(() => {});
      avisarCliente(m, biz, false);
    }
    res.status(201).json({
      membership: { id: m.id, code: m.code, status: m.status, name: m.name, price_cents: m.price_cents, pay_option: m.pay_option },
      ath_phone: op.v === 'ath_manual' ? op.phone : null,
    });
  }));

  async function delNegocio(slug, id) {
    if (!isUuid(id)) return null;
    const { rows } = await db.query(
      `SELECT m.*, b.slug AS biz_slug, ${USADAS('m')} AS usadas FROM memberships m
         JOIN businesses b ON b.id = m.business_id AND b.slug = $1 AND b.deleted_at IS NULL
        WHERE m.id = $2`, [slug, id]);
    return rows[0] || null;
  }

  // Para la página de vuelta del pago (tarjeta) y la espera del ATH.
  app.get('/api/public/:slug/memberships/:id/estado', publicLimiter, asyncH(async (req, res) => {
    const m = await delNegocio(req.params.slug, req.params.id);
    if (!m) return bad(res, 'No encontramos esa membresía.', 404);
    res.json({ membership: vista(m, m.usadas) });
  }));

  // El cliente pagó por ATH al número y deja la referencia para que el negocio la busque.
  app.post('/api/public/:slug/memberships/:id/referencia', codeLimiter, asyncH(async (req, res) => {
    const { reference } = req.body || {};
    if (!isStr(reference, 60)) return bad(res, 'Escribe el número de referencia de ATH Móvil.');
    const m = await delNegocio(req.params.slug, req.params.id);
    if (!m || m.status !== 'pending') return bad(res, 'Esta membresía ya no está esperando pago.', 404);
    const first = !m.pay_ref;
    await db.query(`UPDATE memberships SET pay_ref = $2 WHERE id = $1 AND status = 'pending'`, [m.id, reference.trim()]);
    if (first)
      await notify(m.business_id, 'payment', 'Referencia de ATH de una membresía',
        `${m.buyer_name} · ${m.name} · ${dinero(m.price_cents)} · referencia ${reference.trim()}. Búscala en tu ATH Móvil y confírmala en Membresías.`,
        { membership_id: m.id }).catch(() => {});
    res.json({ ok: true });
  }));

  // ── ATH Móvil automático: el cobro va directo a la cuenta ATH del negocio ──────
  const athPend = new Map();   // ecommerceId → { slug, id, businessId, authToken, publicToken, cents, createdAt }
  setInterval(() => {
    const cut = Date.now() - 12 * 60_000;
    for (const [k, v] of athPend) if (v.createdAt < cut) athPend.delete(k);
  }, 60_000).unref();

  app.post('/api/public/:slug/memberships/:id/ath/start', codeLimiter, asyncH(async (req, res) => {
    const m = await delNegocio(req.params.slug, req.params.id);
    if (!m) return bad(res, 'No encontramos esa membresía.', 404);
    if (m.status === 'active') return res.json({ ok: true, status: 'completed' });
    if (m.status !== 'pending' || m.pay_option !== 'ath_business') return bad(res, 'Esta membresía no se paga por ATH automático.', 409);
    const pp = await db.query(
      `SELECT config->>'ath_public_token' AS token FROM payment_providers
        WHERE business_id = $1 AND provider = 'ath_movil_business' AND is_enabled AND status = 'connected'`, [m.business_id]);
    const token = pp.rows[0] && pp.rows[0].token;
    if (!token) return bad(res, 'El pago por ATH Móvil de este negocio no está disponible ahora. Escoge otra forma de pago.', 409);
    // Una sola solicitud abierta por membresía: dos pestañas no deben poder cobrar dos veces.
    for (const [ecom, v] of athPend)
      if (v.id === m.id && Date.now() - v.createdAt < 10 * 60_000) return res.json({ ok: true, ecommerceId: ecom, reused: true });
    const phone = athRest.athPhone(m.phone);
    if (!phone) return bad(res, 'Ese teléfono no se puede usar con ATH Móvil. Escoge otra forma de pago.', 400);
    const created = await athRest.create(token, process.env.ATHM_ENV || 'production', m.price_cents, phone,
      String(m.business_id), 'membresia:' + m.id, ('Membresía ' + m.name).slice(0, 40));
    if (!created) return bad(res, 'ATH Móvil no aceptó el pago. Intenta de nuevo.', 502);
    athPend.set(created.ecommerceId, { slug: req.params.slug, id: m.id, businessId: m.business_id,
      authToken: created.authToken, publicToken: token, cents: m.price_cents, createdAt: Date.now() });
    res.json({ ok: true, ecommerceId: created.ecommerceId });
  }));

  app.post('/api/public/:slug/memberships/:id/ath/poll', publicLimiter, asyncH(async (req, res) => {
    const { ecommerceId } = req.body || {};
    if (!isStr(ecommerceId, 200)) return bad(res, 'No encontramos ese pago.');
    const pend = athPend.get(ecommerceId);
    if (!pend || pend.slug !== req.params.slug || pend.id !== req.params.id) return bad(res, 'No encontramos ese pago.', 404);
    const found = await athRest.find(pend.publicToken, ecommerceId, pend.authToken);
    const st = found && found.ecommerceStatus;
    if (st === 'CANCEL') { athPend.delete(ecommerceId); return res.json({ status: 'cancelled' }); }
    if (st !== 'CONFIRM' && st !== 'COMPLETED') return res.json({ status: 'pending' });
    const cuadra = (t) => Number.isFinite(Number(t)) && Math.round(Number(t) * 100) === pend.cents;
    // CONFIRM = el cliente aprobó pero todavía no se ha cobrado: todo se revisa ANTES de
    // capturar, para no cobrar algo que no se va a honrar.
    if (st === 'CONFIRM' && !cuadra(found.total)) {
      athPend.delete(ecommerceId);
      return bad(res, 'El monto del pago no coincide con el precio de la membresía. No se cobró nada.', 400);
    }
    const cur = await db.query(`SELECT * FROM memberships WHERE id = $1`, [pend.id]);
    const c = cur.rows[0];
    if (!c || c.status !== 'pending') {
      athPend.delete(ecommerceId);
      if (st === 'COMPLETED') {   // ya se cobró (de otro intento): que el negocio lo sepa
        await pagoSobrante(c, 'ATH Móvil', (found && found.referenceNumber) || ecommerceId);
        return res.json(c && c.status === 'active' ? { status: 'completed' }
          : { status: 'expired', message: 'El pago entró, pero esta membresía ya no estaba esperando pago. Habla con el negocio.' });
      }
      if (c && c.status === 'active') return res.json({ status: 'completed' });
      return res.json({ status: 'expired', message: 'Esta membresía ya no está esperando pago. No se cobró nada.' });
    }
    let fin = found;
    if (st === 'CONFIRM') {
      fin = await athRest.authorize(pend.authToken);
      if (!fin || fin.ecommerceStatus !== 'COMPLETED') return res.json({ status: 'pending' });
    }
    const ref = fin.referenceNumber || ecommerceId;
    if (!cuadra(fin.total)) {   // ya capturado y no cuadra: no se activa y el negocio lo revisa
      athPend.delete(ecommerceId);
      await notify(pend.businessId, 'payment', 'Pago de ATH que no cuadra',
        `Entró un pago por ATH Móvil (referencia ${ref}) que no coincide con el precio de "${c.name}". No activamos la membresía de ${c.buyer_name}: revísalo en tu ATH Business.`,
        { membership_id: c.id }).catch(() => {});
      return bad(res, 'El monto del pago no coincide con el precio de la membresía. Habla con el negocio.', 400);
    }
    // Si activar falla, el pago sigue en athPend y el próximo intento vuelve a activarla.
    const r = await activar(pend.id, { method: 'ath_movil', ref });
    athPend.delete(ecommerceId);
    if (r.already) await pagoSobrante(r.membership, 'ATH Móvil', ref);
    const m = r.membership;
    res.json({ status: 'completed', membership: m ? vista(m, m.visits_adjust || 0) : null });
  }));

  // ── Tarjeta: cargo DIRECTO en la cuenta Stripe del negocio (Connect) ───────────
  // Lo activa el webhook (server.js → activarPorTarjeta), no la vuelta del navegador.
  app.post('/api/public/:slug/memberships/:id/stripe/checkout', codeLimiter, asyncH(async (req, res) => {
    if (!process.env.STRIPE_SECRET_KEY) return bad(res, 'Los pagos con tarjeta no están disponibles ahora mismo. Escoge otra forma de pago.', 409);
    const m = await delNegocio(req.params.slug, req.params.id);
    if (!m) return bad(res, 'No encontramos esa membresía.', 404);
    if (m.status !== 'pending' || m.pay_option !== 'card') return bad(res, 'Esta membresía no se paga con tarjeta.', 409);
    const pp = await db.query(`SELECT config FROM payment_providers WHERE business_id = $1 AND provider = 'stripe'`, [m.business_id]);
    const acct = pp.rows[0] && pp.rows[0].config && pp.rows[0].config.stripe_account_id;
    if (!acct) return bad(res, 'El pago con tarjeta de este negocio no está disponible ahora. Escoge otra forma de pago.', 409);
    const back = `${APP_URL}/membresia.html?slug=${encodeURIComponent(req.params.slug)}&m=${encodeURIComponent(m.id)}`;
    const body = new URLSearchParams();
    body.set('mode', 'payment');
    body.set('line_items[0][price_data][currency]', 'usd');
    body.set('line_items[0][price_data][unit_amount]', String(m.price_cents));
    body.set('line_items[0][price_data][product_data][name]', ('Membresía · ' + m.name).slice(0, 120));
    body.set('line_items[0][quantity]', '1');
    body.set('customer_email', m.email || '');
    body.set('success_url', back + '&pago=ok');
    body.set('cancel_url', back + '&pago=no');
    body.set('metadata[kind]', 'membership');
    body.set('metadata[membership_id]', m.id);
    body.set('payment_intent_data[metadata][kind]', 'membership');
    body.set('payment_intent_data[metadata][membership_id]', m.id);
    // La página de pago vence en 31 minutos (Stripe pide 30 como mínimo): una vieja abierta
    // en otra pestaña no puede cobrar otra vez al día siguiente.
    body.set('expires_at', String(Math.floor(Date.now() / 1000) + 31 * 60));
    if (!m.email) body.delete('customer_email');
    let session;
    try {
      const r = await fetch((process.env.STRIPE_API_BASE || 'https://api.stripe.com') + '/v1/checkout/sessions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY,
                   'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Account': acct },
        body: body.toString(),
        signal: AbortSignal.timeout(20_000),
      });
      session = await r.json();
      if (!r.ok || !session || !session.url) {
        console.error('membresía checkout:', session && session.error ? session.error.message : r.status);
        return bad(res, 'No pudimos abrir el pago con tarjeta. Intenta de nuevo.', 502);
      }
    } catch (e) {
      console.error('membresía checkout:', e.message);
      return bad(res, 'No pudimos abrir el pago con tarjeta. Intenta de nuevo.', 502);
    }
    res.json({ url: session.url });
  }));

  // Consultar (y, si viene con servicios y fecha, ver si cubre esa cita). Pide el
  // código Y el teléfono: con uno solo no se ve nada.
  app.post('/api/public/:slug/memberships/consulta', codeLimiter, asyncH(async (req, res) => {
    const { code, phone, service_ids, start_iso } = req.body || {};
    if (!isStr(code, 40) || !isPhone(phone)) return bad(res, 'Escribe tu código y tu teléfono.');
    const biz = await negocioPublico(req.params.slug);
    if (!biz) return bad(res, 'No encontramos ese negocio.', 404);
    const { rows } = await db.query(
      `SELECT m.*, ${USADAS('m')} AS usadas FROM memberships m WHERE m.business_id = $1 AND m.code = $2`,
      [biz.id, code.trim().toUpperCase()]);
    const m = rows[0];
    if (!m || m.phone !== normPhone(phone))
      return bad(res, 'No encontramos esa membresía con ese teléfono. Revisa el código y usa el teléfono con que la compraste.', 404);
    const out = { membership: vista(m, m.usadas) };
    if (Array.isArray(service_ids)) {
      const ids = service_ids.map(String).filter(isUuid);
      const starts = start_iso ? new Date(start_iso) : null;
      const porque = evaluar(m, m.usadas, ids, starts && !isNaN(starts) ? starts : null);
      out.covers = !porque;
      out.message = porque || (ids.length === 1 ? 'Esta cita usa 1 visita de tu membresía.' : `Esta cita usa ${ids.length} visitas de tu membresía.`);
    }
    res.json(out);
  }));

  console.log('  ✓ módulo membresías montado');
  return { reservar, activarPorTarjeta, revisar };
};
