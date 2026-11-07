// ============================================================================
//  BUKEAME API — módulo: PAGO A PLAZOS (Klarna, Affirm y Acima)
//  El dinero va directo al negocio; Bukéame no guarda llaves de ninguno de los tres.
// ----------------------------------------------------------------------------
//  Se ENCHUFA al server.js base:
//    sharedHelpers.plazos = require('./module-plazos').mount(app, { db, authRequired, businessScope, h });
//
//  · Klarna y Affirm POR STRIPE: el checkout del negocio (Connect, cargo directo) ya los
//    enseña solos cuando el negocio los activa en SU Stripe. Aquí se lee si están activos
//    (capabilities de la cuenta) para decirlo en el panel y en la página pública.
//  · Klarna y Affirm DIRECTO (sin Stripe): el negocio usa su propia cuenta de comerciante y
//    le manda al cliente el enlace desde el portal de Klarna o Affirm. En Bukéame solo se
//    anuncia y, al cobrar, se anota con qué pagó.
//  · Acima (arrendamiento con opción a compra): siempre directo, con el enlace de solicitud
//    que Acima le da al negocio, y solo en los artículos que el negocio marca (Acima no
//    arrienda servicios, ropa, gift cards ni consumibles).
//  · Cobro por enlace desde el panel: el servicio con un enlace o QR a la página de Stripe
//    del negocio (tarjeta, Klarna o Affirm). El webhook de Connect lo marca pagado.
//
//  Rutas (dueño):  GET/PUT /api/plazos, POST /api/plazos/revisar,
//                  PUT /api/plazos/acima/productos/:id,
//                  POST /api/plazos/cobros, GET /api/plazos/cobros[/:id], POST /api/plazos/cobros/:id/cancelar
//  Para el resto: publico(businessId), cobroPagado(id, pago), cerrarAbiertos({appointmentId|businessId}),
//                 metodosCita(), limpiar()
//  Inerte sin la migración 41 (database/41-schema-plazos.sql).
// ============================================================================

module.exports.mount = function (app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, isUuid, isEmail, audit, notify } = h;
  const SQL_PAID_OK = h.SQL_PAID_OK || `(s.plan_code IS NOT NULL AND s.plan_code <> 'free')`;

  const APP_URL = (process.env.APP_URL || 'https://bukeame.com').replace(/\/+$/, '');
  const API = () => (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, '');
  // Acima solo arrienda artículos duraderos de uso personal o del hogar de $300 o más.
  const ACIMA_MIN = Number(process.env.ACIMA_MINIMO_CENTS) || 30000;
  const MODOS = ['off', 'stripe', 'directo'];
  const MAX_COBRO = 3000000;     // $30,000: el tope de Affirm, el más alto de los dos
  const MAX_PROPINA = 100000;    // $1,000
  const COBROS_POR_HORA = 60;
  const CAPS_VIGENCIA_MS = 10 * 60_000;       // el panel vuelve a preguntar a los 10 min
  const CAPS_VIEJAS_MS = 48 * 3600_000;       // la página no anuncia lo que no se ha visto en 2 días

  // ¿Ya corrió la migración 41? Se vuelve a revisar (cada 30 s como mucho) mientras no esté:
  // si Node arranca antes que Postgres, o la migración se corre con el servidor prendido,
  // el módulo se prende solo sin reiniciar.
  let listo = false;
  let enumExtra = [];   // valores nuevos de payment_method que ya existen en la base
  let revisadoEn = 0;
  async function asegurar() {
    if (listo) return true;
    if (Date.now() - revisadoEn < 30_000) return false;
    revisadoEn = Date.now();
    try {
      const t = await db.query(`SELECT to_regclass('public.plazos_config') AS a, to_regclass('public.cobro_enlaces') AS b`);
      const e = await db.query(`SELECT unnest(enum_range(NULL::payment_method))::text AS v`);
      enumExtra = e.rows.map(r => r.v).filter(v => ['klarna', 'affirm', 'acima'].includes(v));
      listo = !!(t.rows[0].a && t.rows[0].b);
    } catch (err) { console.error('plazos: no se pudo revisar la migración 41:', err.message); }
    return listo;
  }
  asegurar();
  const sinMigracion = (res) => bad(res, 'El pago a plazos todavía no está disponible.', 503);

  // ── Stripe por fetch (como module-payments): llave de plataforma + Stripe-Account ──
  async function stripe(method, path, { body, acct, idem } = {}) {
    const headers = { Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY };
    if (acct) headers['Stripe-Account'] = acct;
    if (idem) headers['Idempotency-Key'] = idem;
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const r = await fetch(API() + path, { method, headers, body: body ? body.toString() : undefined, signal: AbortSignal.timeout(10_000) });
    let j = {};
    try { j = await r.json(); } catch (e) { /* cuerpo vacío */ }
    if (!r.ok) {
      const err = new Error((j.error && j.error.message) || ('stripe ' + r.status));
      err.status = r.status;
      throw err;
    }
    return j;
  }
  const esCuenta = v => typeof v === 'string' && /^acct_[A-Za-z0-9]{6,64}$/.test(v);

  // Enlace de solicitud de Acima: https y de un dominio de Acima.
  const esEnlaceAcima = v => {
    if (typeof v !== 'string' || v.length > 500) return false;
    try {
      const u = new URL(v.trim());
      return u.protocol === 'https:' && /(^|\.)(acima\.com|acimacredit\.com)$/i.test(u.hostname) && !u.username && !u.password;
    } catch (e) { return false; }
  };

  // Stripe del negocio: cuenta conectada (OAuth) y/o Payment Link pegado.
  async function stripeDe(businessId) {
    const { rows } = await db.query(
      `SELECT config FROM payment_providers
        WHERE business_id = $1 AND provider = 'stripe' AND status = 'connected'`, [businessId]);
    const cfg = (rows[0] && rows[0].config) || {};
    const acct = esCuenta(cfg.stripe_account_id) ? cfg.stripe_account_id : null;
    return { acct, link: !!cfg.stripe_payment_link, puedeCobrar: !!(acct && process.env.STRIPE_SECRET_KEY) };
  }

  async function configDe(businessId) {
    const { rows } = await db.query(`SELECT * FROM plazos_config WHERE business_id = $1`, [businessId]);
    return rows[0] || { business_id: businessId, klarna: 'off', affirm: 'off', acima_link: null, stripe_caps: {}, caps_at: null };
  }

  // Lo que Stripe dice de la cuenta del negocio: klarna_payments / affirm_payments.
  async function revisarStripe(businessId, acct) {
    const a = await stripe('GET', '/v1/accounts/' + encodeURIComponent(acct));
    const c = (a && a.capabilities) || {};
    const caps = { klarna: c.klarna_payments || 'inactive', affirm: c.affirm_payments || 'inactive' };
    await db.query(
      `INSERT INTO plazos_config (business_id, stripe_caps, caps_at) VALUES ($1, $2, now())
       ON CONFLICT (business_id) DO UPDATE SET stripe_caps = EXCLUDED.stripe_caps, caps_at = now()`,
      [businessId, caps]);
    return caps;
  }

  const planLibre = (req) => (req.business.plan_code || 'free') === 'free';

  async function estado(req, { forzar = false } = {}) {
    const bizId = req.business.id;
    const st = await stripeDe(bizId);
    let cfg = await configDe(bizId);
    let avisoStripe = null;
    const viejo = !cfg.caps_at || (Date.now() - new Date(cfg.caps_at).getTime() > CAPS_VIGENCIA_MS);
    if (st.acct && process.env.STRIPE_SECRET_KEY && (forzar || viejo)) {
      try { await revisarStripe(bizId, st.acct); cfg = await configDe(bizId); }
      catch (e) { console.error('plazos: no se pudo revisar la cuenta de Stripe:', e.message); avisoStripe = 'No pudimos preguntarle a Stripe ahora mismo. Intenta en un rato.'; }
    }
    const caps = cfg.stripe_caps || {};
    const prods = await db.query(
      `SELECT id, name, price_cents, acima_ok FROM products
        WHERE business_id = $1 AND is_active = true ORDER BY price_cents DESC, name LIMIT 200`, [bizId]);
    return {
      plan_locked: planLibre(req),
      stripe: { conectado: !!st.acct, puede_cobrar: st.puedeCobrar, payment_link: st.link, aviso: avisoStripe },
      klarna: { modo: cfg.klarna, en_stripe: st.acct ? (caps.klarna || null) : null },
      affirm: { modo: cfg.affirm, en_stripe: st.acct ? (caps.affirm || null) : null },
      revisado: cfg.caps_at,
      acima: { link: cfg.acima_link || null, min_cents: ACIMA_MIN, productos: prods.rows },
      metodos: metodosCita(),
    };
  }

  // Lo que se puede anotar al cobrar una CITA. Acima no: no arrienda servicios.
  function metodosCita() { return enumExtra.filter(v => v === 'klarna' || v === 'affirm'); }

  // ── GET /api/plazos — lo que ofrece el negocio y lo que dice su Stripe ──────────
  app.get('/api/plazos', authRequired, businessScope, asyncH(async (req, res) => {
    if (!(await asegurar())) return sinMigracion(res);
    res.json(await estado(req));
  }));

  // ── POST /api/plazos/revisar — vuelve a preguntarle a Stripe (tras activarlo allá) ──
  app.post('/api/plazos/revisar', authRequired, businessScope, asyncH(async (req, res) => {
    if (!(await asegurar())) return sinMigracion(res);
    res.json(await estado(req, { forzar: true }));
  }));

  // ── PUT /api/plazos {klarna, affirm, acima_link} ────────────────────────────────
  app.put('/api/plazos', authRequired, businessScope, asyncH(async (req, res) => {
    if (!(await asegurar())) return sinMigracion(res);
    const b = req.body || {};
    const cur = await configDe(req.business.id);
    const klarna = b.klarna === undefined ? cur.klarna : b.klarna;
    const affirm = b.affirm === undefined ? cur.affirm : b.affirm;
    if (!MODOS.includes(klarna) || !MODOS.includes(affirm)) return bad(res, 'Escoge cómo ofreces cada uno.');
    let acima = cur.acima_link;
    if (b.acima_link !== undefined) {
      if (b.acima_link === null || String(b.acima_link).trim() === '') acima = null;
      else if (!esEnlaceAcima(b.acima_link)) return bad(res, 'Pega el enlace de solicitud que te dio Acima (empieza con https:// y es de acima.com).');
      else acima = String(b.acima_link).trim();
    }
    const enciende = klarna !== 'off' || affirm !== 'off' || !!acima;
    if (enciende && planLibre(req))
      return bad(res, 'El pago a plazos está disponible desde el plan Pro, como los demás pagos en línea.', 403);
    if (klarna === 'stripe' || affirm === 'stripe') {
      const st = await stripeDe(req.business.id);
      if (!st.acct && !st.link) return bad(res, 'Conecta tu Stripe primero (arriba, en Pagos) o escoge "Con mi cuenta directa".', 409);
    }
    await db.query(
      `INSERT INTO plazos_config (business_id, klarna, affirm, acima_link, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (business_id) DO UPDATE SET klarna = $2, affirm = $3, acima_link = $4, updated_at = now()`,
      [req.business.id, klarna, affirm, acima]);
    await audit(req, 'plazos.update', 'plazos_config', null, { klarna, affirm, acima: !!acima });
    res.json(await estado(req));
  }));

  // ── PUT /api/plazos/acima/productos/:id {acima_ok} ──────────────────────────────
  app.put('/api/plazos/acima/productos/:id', authRequired, businessScope, asyncH(async (req, res) => {
    if (!(await asegurar())) return sinMigracion(res);
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const ok = req.body && req.body.acima_ok;
    if (typeof ok !== 'boolean') return bad(res, 'Falta acima_ok');
    const { rows } = await db.query(
      `SELECT id, price_cents FROM products WHERE id = $1 AND business_id = $2`, [req.params.id, req.business.id]);
    if (!rows[0]) return bad(res, 'Producto no encontrado', 404);
    if (ok && rows[0].price_cents < ACIMA_MIN)
      return bad(res, `Acima solo arrienda artículos de $${(ACIMA_MIN / 100).toFixed(0)} o más.`, 409);
    await db.query(`UPDATE products SET acima_ok = $3 WHERE id = $1 AND business_id = $2`, [req.params.id, req.business.id, ok]);
    res.json({ ok: true, acima_ok: ok });
  }));

  // ══════════════════════════════════════════════════════════════════════════════
  //  COBRO POR ENLACE (Stripe del negocio, cargo directo)
  // ══════════════════════════════════════════════════════════════════════════════
  const cobroPublico = (e) => ({
    id: e.id, appointment_id: e.appointment_id, status: e.status, method: e.method,
    amount_cents: e.amount_cents, tip_cents: e.tip_cents, total_cents: e.total_cents,
    url: e.status === 'open' ? e.url : null, expires_at: e.expires_at, paid_at: e.paid_at,
  });

  // Cierra la sesión en Stripe. 'cerrada' si ya no se puede pagar; 'pagada' si el cliente
  // alcanzó a pagar (se anota aquí mismo); 'error' si Stripe no contestó: entonces NO se da
  // por cancelada, porque el cliente todavía podría pagarla.
  async function cerrarEnStripe(e) {
    if (!e.session_id) return 'cerrada';   // la sesión nunca llegó a existir (o se está creando)
    const acct = e.stripe_account;
    if (!esCuenta(acct)) return 'error';
    const ses = encodeURIComponent(e.session_id);
    try { await stripe('POST', `/v1/checkout/sessions/${ses}/expire`, { acct }); return 'cerrada'; }
    catch (err) {
      try {
        const s = await stripe('GET', `/v1/checkout/sessions/${ses}`, { acct });
        if (s.status === 'expired') return 'cerrada';
        if (s.status === 'complete' && s.payment_status === 'paid') {
          await cobroPagado(e.id, {
            account: acct, amount: Number(s.amount_total), currency: String(s.currency || '').toLowerCase(),
            paid: true, ref: s.payment_intent || s.id, pi: s.payment_intent,
          });
          return 'pagada';
        }
      } catch (err2) { console.error('plazos: no se pudo ver el enlace en Stripe:', err2.message); }
      console.error('plazos: no se pudo cerrar el enlace en Stripe:', err.message);
      return 'error';
    }
  }

  // Cierra los enlaces abiertos de una cita (al completarla, cancelarla o marcar que no
  // llegó) o de todo el negocio (al desconectar Stripe). 'pagada' si alguno ya se pagó,
  // 'error' si alguno no se pudo cerrar, si no 'cerrado'.
  async function cerrarAbiertos({ appointmentId, businessId } = {}) {
    if (!(await asegurar())) return 'cerrado';
    const { rows } = appointmentId
      ? await db.query(`SELECT * FROM cobro_enlaces WHERE appointment_id = $1 AND status = 'open'`, [appointmentId])
      : await db.query(`SELECT * FROM cobro_enlaces WHERE business_id = $1 AND status = 'open'`, [businessId]);
    let pagada = false, error = false;
    for (const e of rows) {
      const r = await cerrarEnStripe(e);
      if (r === 'cerrada') await db.query(`UPDATE cobro_enlaces SET status = 'cancelled' WHERE id = $1 AND status = 'open'`, [e.id]);
      else if (r === 'pagada') pagada = true;
      else error = true;
    }
    return pagada ? 'pagada' : (error ? 'error' : 'cerrado');
  }

  // ── POST /api/plazos/cobros {appointment_id, amount_cents, tip_cents} ──────────
  app.post('/api/plazos/cobros', authRequired, businessScope, asyncH(async (req, res) => {
    if (!(await asegurar())) return sinMigracion(res);
    if (planLibre(req)) return bad(res, 'Cobrar por enlace está disponible desde el plan Pro.', 403);
    const { appointment_id } = req.body || {};
    const amount = req.body && req.body.amount_cents;
    const tip = (req.body && req.body.tip_cents) || 0;
    if (!isUuid(appointment_id)) return bad(res, 'Falta la cita');
    if (!Number.isInteger(amount) || amount < 0 || amount > MAX_COBRO) return bad(res, 'Escribe el monto a cobrar.');
    if (!Number.isInteger(tip) || tip < 0 || tip > MAX_PROPINA) return bad(res, 'La propina no es válida.');
    const total = amount + tip;
    if (total < 50) return bad(res, 'El cobro por enlace tiene que ser de por lo menos $0.50.');

    const st = await stripeDe(req.business.id);
    if (!st.puedeCobrar) return bad(res, 'Para cobrar por enlace conecta tu Stripe con el botón "Conectar con Stripe" en Pagos.', 409);

    const { rows } = await db.query(
      `SELECT a.id, a.status, a.service_name, c.email
         FROM appointments a LEFT JOIN clients c ON c.id = a.client_id
        WHERE a.id = $1 AND a.business_id = $2`, [appointment_id, req.business.id]);
    const a = rows[0];
    if (!a) return bad(res, 'Cita no encontrada', 404);
    if (!['confirmed', 'pending_deposit', 'completed'].includes(a.status))
      return bad(res, 'Esta cita no se puede cobrar (está cancelada o el cliente no llegó).', 409);
    const ya = await db.query(`SELECT 1 FROM payments WHERE appointment_id = $1 AND kind = 'balance' LIMIT 1`, [a.id]);
    if (ya.rows[0]) return bad(res, 'Esta cita ya tiene su cobro anotado.', 409);

    // Si ya hay un enlace abierto por lo mismo, se devuelve ese; si es por otro monto, se
    // cierra en Stripe antes de hacer el nuevo (si no se puede cerrar, no se hace otro).
    const abiertos = await db.query(
      `SELECT * FROM cobro_enlaces WHERE appointment_id = $1 AND status = 'open' ORDER BY created_at DESC`, [a.id]);
    for (const e of abiertos.rows) {
      if (e.total_cents === total && e.amount_cents === amount && e.url && e.stripe_account === st.acct
          && new Date(e.expires_at) > new Date(Date.now() + 30 * 60_000))
        return res.json(cobroPublico(e));
      const r = await cerrarEnStripe(e);
      if (r === 'pagada') return bad(res, 'El cliente ya pagó el enlace anterior: la cita quedó cobrada.', 409);
      if (r === 'error') return bad(res, 'No pudimos cerrar el enlace anterior en Stripe. Intenta otra vez en un momento.', 502);
      await db.query(`UPDATE cobro_enlaces SET status = 'cancelled' WHERE id = $1 AND status = 'open'`, [e.id]);
    }
    const hora = await db.query(
      `SELECT count(*)::int AS n FROM cobro_enlaces WHERE business_id = $1 AND created_at > now() - interval '1 hour'`, [req.business.id]);
    if (hora.rows[0].n >= COBROS_POR_HORA) return bad(res, 'Hiciste muchos enlaces de cobro en la última hora. Espera un poco.', 429);

    const expira = new Date(Date.now() + 23 * 3600_000);
    let e;
    try {
      e = (await db.query(
        `INSERT INTO cobro_enlaces (business_id, appointment_id, amount_cents, tip_cents, total_cents, stripe_account, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [req.business.id, a.id, amount, tip, total, st.acct, req.user && req.user.id ? req.user.id : null, expira])).rows[0];
    } catch (err) {
      // Índice único: un solo enlace abierto por cita (dos pestañas a la vez).
      if (err.code === '23505') return bad(res, 'Ya se está creando un enlace para esta cita. Espera un momento.', 409);
      throw err;
    }

    const servicio = String(a.service_name || 'Servicio').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Servicio';
    const body = new URLSearchParams();
    body.set('mode', 'payment');
    body.set('submit_type', 'pay');
    let i = 0;
    if (amount > 0) {
      body.set(`line_items[${i}][price_data][currency]`, 'usd');
      body.set(`line_items[${i}][price_data][unit_amount]`, String(amount));
      body.set(`line_items[${i}][price_data][product_data][name]`, servicio);
      body.set(`line_items[${i}][quantity]`, '1');
      i++;
    }
    if (tip > 0) {
      body.set(`line_items[${i}][price_data][currency]`, 'usd');
      body.set(`line_items[${i}][price_data][unit_amount]`, String(tip));
      body.set(`line_items[${i}][price_data][product_data][name]`, 'Propina');
      body.set(`line_items[${i}][quantity]`, '1');
    }
    // A la página del negocio, sin el código de la cita: el enlace se reenvía o se escanea
    // en pantalla, y el código abre la cita (con el botón de cancelarla).
    const pagina = `${APP_URL}/negocio.html?slug=${encodeURIComponent(req.business.slug || '')}`;
    body.set('success_url', `${pagina}&cobro=ok`);
    body.set('cancel_url', pagina);
    body.set('expires_at', String(Math.floor(expira.getTime() / 1000)));
    body.set('metadata[kind]', 'cobro');
    body.set('metadata[cobro_id]', e.id);
    body.set('payment_intent_data[metadata][kind]', 'cobro');
    body.set('payment_intent_data[metadata][cobro_id]', e.id);
    body.set('payment_intent_data[description]', servicio);
    if (a.email && isEmail(String(a.email))) body.set('customer_email', String(a.email));

    let ses;
    try { ses = await stripe('POST', '/v1/checkout/sessions', { body, acct: st.acct, idem: 'cobro-' + e.id }); }
    catch (err) { console.error('plazos: no se pudo crear el enlace de cobro:', err.message); ses = null; }
    if (!ses || !ses.id || !ses.url) {
      await db.query(`UPDATE cobro_enlaces SET status = 'cancelled' WHERE id = $1 AND status = 'open'`, [e.id]);
      return bad(res, 'Stripe no pudo crear el enlace ahora mismo. Intenta de nuevo o cobra de otra forma.', 502);
    }
    const up = await db.query(
      `UPDATE cobro_enlaces SET session_id = $2, url = $3 WHERE id = $1 AND status = 'open' RETURNING *`, [e.id, ses.id, ses.url]);
    if (!up.rows[0]) {
      // Lo cancelaron mientras se creaba: se cierra también en Stripe.
      await db.query(`UPDATE cobro_enlaces SET session_id = $2 WHERE id = $1`, [e.id, ses.id]);
      try { await stripe('POST', `/v1/checkout/sessions/${encodeURIComponent(ses.id)}/expire`, { acct: st.acct }); }
      catch (err) { console.error('plazos: no se pudo cerrar un enlace cancelado al crearse:', err.message); }
      return bad(res, 'El enlace se canceló mientras se creaba. Vuelve a intentarlo.', 409);
    }
    await audit(req, 'plazos.cobro', 'appointment', a.id, { total_cents: total });
    res.json(cobroPublico(up.rows[0]));
  }));

  // ── GET /api/plazos/cobros?appointment_id= — el último enlace y el depósito ya pagado ──
  app.get('/api/plazos/cobros', authRequired, businessScope, asyncH(async (req, res) => {
    if (!(await asegurar())) return sinMigracion(res);
    const apptId = String(req.query.appointment_id || '');
    if (!isUuid(apptId)) return bad(res, 'Falta la cita');
    const a = await db.query(
      `SELECT COALESCE((SELECT sum(p.amount_cents) FROM payments p
                         WHERE p.appointment_id = a.id AND p.kind = 'deposit' AND p.status = 'paid'), 0)::int AS deposito
         FROM appointments a WHERE a.id = $1 AND a.business_id = $2`, [apptId, req.business.id]);
    if (!a.rows[0]) return bad(res, 'Cita no encontrada', 404);
    const { rows } = await db.query(
      `SELECT * FROM cobro_enlaces WHERE business_id = $1 AND appointment_id = $2
          AND status IN ('open','paid') ORDER BY created_at DESC LIMIT 1`, [req.business.id, apptId]);
    res.json({ cobro: rows[0] ? cobroPublico(rows[0]) : null, deposito_cents: a.rows[0].deposito });
  }));

  // ── GET /api/plazos/cobros/:id — para que el panel sepa cuándo pagó ─────────────
  app.get('/api/plazos/cobros/:id', authRequired, businessScope, asyncH(async (req, res) => {
    if (!(await asegurar())) return sinMigracion(res);
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const { rows } = await db.query(
      `SELECT * FROM cobro_enlaces WHERE id = $1 AND business_id = $2`, [req.params.id, req.business.id]);
    if (!rows[0]) return bad(res, 'Cobro no encontrado', 404);
    res.json(cobroPublico(rows[0]));
  }));

  // ── POST /api/plazos/cobros/:id/cancelar — cierra el enlace en Stripe ───────────
  app.post('/api/plazos/cobros/:id/cancelar', authRequired, businessScope, asyncH(async (req, res) => {
    if (!(await asegurar())) return sinMigracion(res);
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const sel = () => db.query(`SELECT * FROM cobro_enlaces WHERE id = $1 AND business_id = $2`, [req.params.id, req.business.id]);
    const e = (await sel()).rows[0];
    if (!e) return bad(res, 'Cobro no encontrado', 404);
    if (e.status !== 'open') return res.json(cobroPublico(e));
    const r = await cerrarEnStripe(e);
    if (r === 'error') return bad(res, 'No pudimos cerrar el enlace en Stripe. Intenta otra vez en un momento; mientras, el cliente todavía podría pagarlo.', 502);
    if (r === 'cerrada') await db.query(`UPDATE cobro_enlaces SET status = 'cancelled' WHERE id = $1 AND status = 'open'`, [e.id]);
    // Si el cliente pagó justo antes de cerrar, ya quedó anotado y aquí sale "pagado".
    res.json(cobroPublico((await sel()).rows[0]));
  }));

  // Con qué pagó (tarjeta, Klarna o Affirm): lo dice el PaymentIntent en la cuenta del
  // negocio. Si Stripe no contesta, se lanza el error para que el webhook reintente en vez
  // de anotar "tarjeta" para siempre.
  async function metodoDelPago(pi, acct) {
    if (typeof pi !== 'string' || !/^pi_[A-Za-z0-9_]+$/.test(pi)) return 'card';
    let ultimo;
    for (let i = 0; i < 2; i++) {
      try {
        const p = await stripe('GET', `/v1/payment_intents/${encodeURIComponent(pi)}?expand[]=payment_method`, { acct });
        const t = p && p.payment_method && p.payment_method.type;
        return (t === 'klarna' || t === 'affirm') && enumExtra.includes(t) ? t : 'card';
      } catch (e) { ultimo = e; }
    }
    throw new Error('no se pudo ver con qué pagó: ' + ultimo.message);
  }

  const usd = (c) => '$' + (Number(c || 0) / 100).toFixed(2);
  const NOMBRE = { card: 'tarjeta', klarna: 'Klarna', affirm: 'Affirm' };

  // Webhook de Connect (server.js) con metadata kind='cobro'. Solo vale un pago hecho en la
  // cuenta Stripe con la que se creó el enlace, por el total exacto, en dólares y cobrado.
  // La cita y el monto salen de la fila, nunca de la metadata. Idempotente. Si el módulo no
  // está listo, lanza el error para que el webhook conteste 500 y Stripe reintente.
  async function cobroPagado(id, pago) {
    if (!isUuid(id) || !pago || !pago.paid) return;
    if (!(await asegurar())) throw new Error('pago a plazos sin la migración 41');
    const { rows } = await db.query(
      `SELECT e.*, a.service_name, pp.config->>'stripe_account_id' AS acct
         FROM cobro_enlaces e
         JOIN appointments a ON a.id = e.appointment_id
         LEFT JOIN payment_providers pp ON pp.business_id = e.business_id AND pp.provider = 'stripe'
        WHERE e.id = $1`, [id]);
    const e = rows[0];
    if (!e) return;
    const cuenta = e.stripe_account || e.acct;
    if (!pago.account || !cuenta || pago.account !== cuenta) {
      console.error('plazos: el pago no viene de la cuenta del negocio', id, pago.account);
      return;
    }
    if (pago.amount !== e.total_cents || pago.currency !== 'usd') {
      console.error('plazos: el pago no cuadra', id, pago.amount, pago.currency);
      // Llegan dos eventos por pago (la sesión y el PaymentIntent) y Stripe reintenta: un aviso.
      const primera = await db.query(
        `UPDATE cobro_enlaces SET descuadre_at = now() WHERE id = $1 AND descuadre_at IS NULL RETURNING id`, [e.id]);
      if (primera.rowCount) {
        try {
          await notify(e.business_id, 'payment', 'Pago por enlace que no cuadra',
            `Llegó un pago de ${usd(pago.amount)} para un cobro de ${usd(e.total_cents)} de ${e.service_name || 'una cita'} y no lo anotamos. Revísalo en tu Stripe.`,
            { appointment_id: e.appointment_id });
        } catch (err) { console.error('plazos notify:', err.message); }
      }
      return;
    }
    if (e.status === 'paid') return;
    const metodo = await metodoDelPago(pago.pi, cuenta);

    const client = await db.connect();
    let aviso = null;
    try {
      await client.query('BEGIN');
      const up = await client.query(
        `UPDATE cobro_enlaces SET status = 'paid', paid_at = now(), method = $2::payment_method, external_ref = $3
          WHERE id = $1 AND status <> 'paid' RETURNING id`, [e.id, metodo, pago.ref || null]);
      if (!up.rowCount) { await client.query('ROLLBACK'); return; }
      const a = (await client.query(
        `SELECT id, status, client_id FROM appointments WHERE id = $1 FOR UPDATE`, [e.appointment_id])).rows[0];
      // Como "Completar y cobrar" del panel: la visita cuenta una vez, sin la propina.
      if (a && ['confirmed', 'pending_deposit'].includes(a.status)) {
        await client.query(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [a.id]);
        await client.query(
          `UPDATE clients SET total_visits = total_visits + 1, total_spent_cents = total_spent_cents + $2,
                  last_visit_at = now() WHERE id = $1`, [a.client_id, e.amount_cents]);
      }
      const doble = (await client.query(
        `SELECT 1 FROM payments WHERE appointment_id = $1 AND kind = 'balance' LIMIT 1`, [e.appointment_id])).rows[0];
      const pay = await client.query(
        `INSERT INTO payments (business_id, appointment_id, client_id, kind, method, amount_cents, tip_cents, status, paid_at, external_ref)
         VALUES ($1, $2, $3, 'balance', $4::payment_method, $5, $6, 'paid', now(), $7) RETURNING id`,
        [e.business_id, e.appointment_id, a ? a.client_id : null, metodo, e.amount_cents, e.tip_cents, pago.ref || null]);
      await client.query(`UPDATE cobro_enlaces SET payment_id = $2 WHERE id = $1`, [e.id, pay.rows[0].id]);
      await client.query('COMMIT');
      if (doble) aviso = 'Esta cita ya tenía otro cobro anotado: revisa si el cliente pagó dos veces.';
      else if (a && !['confirmed', 'pending_deposit', 'completed'].includes(a.status)) aviso = 'La cita estaba cancelada o marcada como no llegó.';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
    try {
      await notify(e.business_id, 'payment', aviso ? 'Pago por enlace para revisar' : 'Pago por enlace recibido',
        `${e.service_name || 'Cita'} · ${usd(e.total_cents)} con ${NOMBRE[metodo] || 'tarjeta'}` + (aviso ? ` · ${aviso}` : ''),
        { appointment_id: e.appointment_id });
    } catch (err) { console.error('plazos notify:', err.message); }
  }

  // Lo que ve el cliente en la página del negocio (nada secreto). Solo con plan de pago.
  async function publico(businessId) {
    if (!(await asegurar())) return null;
    const { rows } = await db.query(
      `SELECT pc.klarna, pc.affirm, pc.acima_link, pc.stripe_caps, pc.caps_at, ${SQL_PAID_OK} AS pago_ok,
              pp.config->>'stripe_account_id' AS acct, pp.config->>'stripe_payment_link' AS plink
         FROM plazos_config pc
         JOIN businesses b ON b.id = pc.business_id
         LEFT JOIN subscriptions s ON s.business_id = b.id
         LEFT JOIN plans p ON p.code = s.plan_code
         LEFT JOIN payment_providers pp ON pp.business_id = b.id AND pp.provider = 'stripe'
                                       AND pp.status = 'connected' AND pp.is_enabled = true
        WHERE pc.business_id = $1`, [businessId]);
    const r = rows[0];
    if (!r || !r.pago_ok) return null;
    const caps = r.stripe_caps || {};
    const capsAlDia = r.caps_at && (Date.now() - new Date(r.caps_at).getTime() < CAPS_VIEJAS_MS);
    // Por Stripe: con cuenta conectada se le cree a Stripe (si lo vio en los últimos 2 días);
    // con solo el Payment Link no se puede preguntar y se le cree al negocio.
    const via = (modo, cap) => {
      if (modo === 'directo') return 'directo';
      if (modo !== 'stripe') return null;
      if (esCuenta(r.acct)) return capsAlDia && caps[cap] === 'active' ? 'stripe' : null;
      return r.plink ? 'stripe' : null;
    };
    const out = {
      klarna: via(r.klarna, 'klarna'),
      affirm: via(r.affirm, 'affirm'),
      acima: r.acima_link ? { link: r.acima_link, min_cents: ACIMA_MIN } : null,
    };
    return (out.klarna || out.affirm || out.acima) ? out : null;
  }

  // Cada hora: los enlaces vencen a las 23 h (Stripe los cierra a las 24 h), y lo que dice
  // Stripe de cada cuenta se refresca a diario para no anunciar algo que el negocio apagó.
  async function limpiar() {
    if (!(await asegurar())) return;
    await db.query(`UPDATE cobro_enlaces SET status = 'expired' WHERE status = 'open' AND expires_at < now()`);
    if (!process.env.STRIPE_SECRET_KEY) return;
    const { rows } = await db.query(
      `SELECT pc.business_id, pp.config->>'stripe_account_id' AS acct
         FROM plazos_config pc
         JOIN payment_providers pp ON pp.business_id = pc.business_id AND pp.provider = 'stripe' AND pp.status = 'connected'
        WHERE (pc.klarna = 'stripe' OR pc.affirm = 'stripe')
          AND (pc.caps_at IS NULL OR pc.caps_at < now() - interval '20 hours')
        ORDER BY pc.caps_at NULLS FIRST LIMIT 50`);
    for (const r of rows) {
      if (!esCuenta(r.acct)) continue;
      try { await revisarStripe(r.business_id, r.acct); }
      catch (e) { console.error('plazos: no se pudo refrescar la cuenta de Stripe:', e.message); }
    }
  }

  console.log('  ✓ módulo pago a plazos montado (Klarna/Affirm por Stripe o directo, Acima por enlace)');
  return { publico, cobroPagado, cerrarAbiertos, limpiar, metodosCita, listo: () => listo };
};
