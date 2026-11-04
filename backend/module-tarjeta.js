// ============================================================================
//  BUKEAME API — módulo COBRO CON TARJETA (Stripe Billing, cuenta de Wifnix)
// ----------------------------------------------------------------------------
//  El dueño paga su plan o sus add-ons con tarjeta y se renuevan solos cada mes.
//  ATH Móvil sigue igual (un mes a la vez); la tarjeta es la otra opción, al mismo precio.
//
//  Cómo se cobra:
//    · Cada compra es una suscripción de Stripe: el plan solo, o los add-ons que se
//      escogieron juntos (una suscripción con un renglón por add-on).
//    · Compra nueva → se cobra hoy.
//    · Algo que ya está pagado por ATH (o el plan en su prueba gratis) → hoy no se
//      cobra nada; el primer cobro es el día que se acaba lo pagado.
//    · Subir de plan pagado por ATH → hoy se descuenta lo que le quedaba del plan de antes.
//    · Subir de plan con el plan ya en tarjeta → Stripe cobra hoy la diferencia prorrateada.
//    · Cancelar = no renovar: se conserva hasta el fin de lo pagado (+7 días de gracia).
//
//  El acceso sale de current_period_end, igual que con ATH, y SOLO lo mueve una
//  factura pagada. Los eventos de la suscripción solo copian su estado (renglones,
//  cancelación, pago atrasado). Un conciliador revisa cada hora lo que vence pronto,
//  por si se perdió un webhook.
//
//  Rutas:
//    Panel    GET /api/billing/tarjeta/config, POST /api/billing/tarjeta/checkout,
//             GET /api/billing/tarjeta/estado, POST /api/billing/tarjeta/reanudar,
//             POST /api/billing/tarjeta/quitar (borra la tarjeta y todo cobro automático),
//             POST /api/billing/tarjeta/portal
//    Stripe   POST /api/billing/stripe/webhook (cuerpo crudo: express.raw en server.js)
//
//  Llaves (.env): STRIPE_SECRET_KEY (la misma de Connect) + STRIPE_BILLING_WEBHOOK_SECRET
//  (el secreto del endpoint de la cuenta, aparte del de Connect). Sin las dos no se
//  ofrece la tarjeta y no se llama a Stripe.
// ============================================================================

const PR_TZ = 'America/Puerto_Rico';
const DIA_MS = 864e5;
const MES_MS = 30 * DIA_MS;        // para el crédito por días de un plan pagado por ATH
const COBRO_MINIMO = 50;           // Stripe no cobra menos de $0.50
const PLAN_ORDER = ['free', 'pro', 'studio', 'team', 'grande', 'ilimitado'];
const MUERTA = ['canceled', 'incomplete_expired'];

const dinero = c => '$' + (c / 100).toFixed(2);
const fechaPR = ts => new Date(ts).toLocaleDateString('es-PR', { timeZone: PR_TZ, day: 'numeric', month: 'long' });
const orden = c => PLAN_ORDER.indexOf(c);
const idDe = x => (x && typeof x === 'object') ? x.id : (x || null);
// Los productos de Stripe llevan el código: bukeame_plan_pro, bukeame_addon_win_back.
const productoId = (kind, code) => `bukeame_${kind}_${code}`;
function deProducto(id) {
  const m = /^bukeame_(plan|addon)_([a-z0-9_]+)$/.exec(String(idDe(id) || ''));
  return m ? { kind: m[1], code: m[2] } : null;
}

function mount(app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, isStr, isUuid, audit, notify, alertOwner, sendEmail, emailPlatformReceipt } = h;
  const PANEL = [authRequired, businessScope];

  const KEY = process.env.STRIPE_SECRET_KEY || '';
  const WH = process.env.STRIPE_BILLING_WEBHOOK_SECRET || '';
  const BASE = (process.env.APP_URL || 'https://bukeame.com').replace(/\/+$/, '');
  const lista = () => !!(KEY && WH);
  // TARJETA_PILOTO=<id,id>: solo esos negocios ven la tarjeta. Sirve para probar en el
  // servidor con las llaves de prueba de Stripe sin que los demás la vean.
  const PILOTO = new Set(String(process.env.TARJETA_PILOTO || '').split(',').map(s => s.trim()).filter(Boolean));
  const paraNegocio = (bid) => lista() && (!PILOTO.size || PILOTO.has(bid));
  const NO_DISPONIBLE = 'El pago con tarjeta todavía no está disponible';

  let stripe = null;
  function sdk() {
    if (stripe) return stripe;
    const Stripe = require('stripe');
    const cfg = { maxNetworkRetries: 2, timeout: 20000, appInfo: { name: 'Bukeame' } };
    if (process.env.STRIPE_API_BASE) {        // solo pruebas: un Stripe simulado
      const u = new URL(process.env.STRIPE_API_BASE);
      Object.assign(cfg, { host: u.hostname, port: u.port, protocol: u.protocol.replace(':', '') });
    }
    stripe = new Stripe(KEY, cfg);
    return stripe;
  }
  const falla = (msg, st) => { const e = new Error(msg); e.userMsg = msg; e.httpStatus = st || 400; return e; };

  async function negocio(bid) {
    const { rows } = await db.query(
      `SELECT b.id, b.name, u.email AS owner_email,
              s.id AS sub_row, s.plan_code::text AS plan_code, s.status::text AS status, s.current_period_end,
              s.trial_ends_at, s.cancel_at_period_end, s.stripe_customer_id, s.stripe_subscription_id, s.stripe_item_id
         FROM businesses b JOIN users u ON u.id = b.owner_user_id
         LEFT JOIN subscriptions s ON s.business_id = b.id
        WHERE b.id = $1 AND b.deleted_at IS NULL`, [bid]);
    return rows[0] || null;
  }

  // Un cliente de Stripe por negocio. El idempotencyKey hace que dos pedidos a la vez
  // reciban el mismo cliente.
  async function cliente(n) {
    if (n.stripe_customer_id) return n.stripe_customer_id;
    const c = await sdk().customers.create({
      email: n.owner_email || undefined, name: n.name, preferred_locales: ['es'],
      metadata: { business_id: n.id },
    }, { idempotencyKey: 'bk-cliente-' + n.id });
    await db.query(
      `UPDATE subscriptions SET stripe_customer_id = $2 WHERE business_id = $1 AND stripe_customer_id IS NULL`,
      [n.id, c.id]);
    n.stripe_customer_id = c.id;
    return c.id;
  }

  // Precio mensual de Stripe para este plan o add-on, creado la primera vez. La clave
  // lleva el monto: si cambia el precio en la base sale un precio nuevo y las
  // suscripciones viejas siguen con el suyo. Si cambia el nombre, se pone al día.
  const precios = new Map();
  async function precio(it) {
    const clave = `${productoId(it.kind, it.code)}_${it.cents}`;
    const nombre = 'Bukéame · ' + it.nombre;   // sale en Checkout, el portal y la factura
    const memo = clave + '|' + nombre;
    if (precios.has(memo)) return precios.get(memo);
    const s = sdk();
    const pid = productoId(it.kind, it.code);
    try {
      const prod = await s.products.retrieve(pid);
      if (prod.name !== nombre) await s.products.update(pid, { name: nombre });
    } catch (e) {
      if (e.code !== 'resource_missing') throw e;
      await s.products.create({ id: pid, name: nombre, metadata: { kind: it.kind, code: it.code } },
        { idempotencyKey: 'bk-producto-' + pid });
    }
    const hay = await s.prices.list({ lookup_keys: [clave], active: true, limit: 1 });
    const p = hay.data[0] || await s.prices.create({
      product: pid, currency: 'usd', unit_amount: it.cents, recurring: { interval: 'month' },
      lookup_key: clave, metadata: { kind: it.kind, code: it.code },
    }, { idempotencyKey: 'bk-precio-' + clave });
    precios.set(memo, p.id);
    return p.id;
  }

  // Qué se puede pagar con tarjeta: un plan de pago, o add-ons mensuales que se venden.
  async function articulos(n, kind, body) {
    if (kind === 'plan') {
      const code = String(body.code || '').trim().toLowerCase();
      if (!isStr(code, 40) || code === 'free') throw falla('Ese plan no se cobra');
      const { rows } = await db.query(
        `SELECT code::text AS code, name, price_monthly_cents FROM plans WHERE code::text = $1 AND is_active`, [code]);
      const p = rows[0];
      if (!p || !(p.price_monthly_cents > 0)) throw falla('Ese plan ya no está disponible. Recarga la página e intenta de nuevo.', 404);
      return [{ kind: 'plan', code: p.code, nombre: 'Plan ' + p.name, cents: p.price_monthly_cents }];
    }
    const pedidos = Array.isArray(body.codes) ? body.codes : [body.code];
    const codes = [...new Set(pedidos.map(c => String(c == null ? '' : c).trim()).filter(c => c && c.length <= 60))];
    if (!codes.length || codes.length > 10) throw falla('Escoge entre 1 y 10 add-ons');
    const { rows } = await db.query(
      `SELECT code::text AS code, name, price_cents, billing FROM addon_catalog WHERE code::text = ANY($1::text[])`, [codes]);
    if (rows.length !== codes.length) throw falla('Uno de los add-ons ya no está disponible. Recarga la página e intenta de nuevo.', 404);
    for (const a of rows) {
      if (a.billing !== 'monthly' || !(a.price_cents > 0)) throw falla(`"${a.name}" no es una mensualidad`);
      if (h.addonVendible && !h.addonVendible(a.code)) throw falla(`"${a.name}" todavía no está disponible`, 409);
      if (a.code === 'payroll' && orden(n.plan_code) < orden('studio')) throw falla('La nómina está disponible desde el plan Studio', 403);
    }
    return rows.map(a => ({ kind: 'addon', code: a.code, nombre: a.name, cents: a.price_cents }));
  }

  // ── Lo que se va a cobrar, en palabras (se enseña ANTES de ir a Stripe) ──────
  function aviso(p) {
    const cuantos = p.items.length > 1 ? 'los' : 'lo';
    const cola = ` ${cuantos === 'los' ? 'Los' : 'Lo'} cancelas cuando quieras en Mi cuenta y ${cuantos} conservas hasta el final de lo pagado.`;
    if (p.modo === 'subir')
      return `Se cobra hoy a tu tarjeta la diferencia por los días que faltan para tu próximo cobro (unos ${dinero(p.hoy)}). ` +
             `Desde el próximo cobro${p.desde ? ', el ' + fechaPR(p.desde) : ''}, pagas ${dinero(p.mensual)} al mes.` + cola;
    if (p.modo === 'ancla')
      return `Hoy no se cobra nada: ${p.prueba ? 'tu prueba gratis sigue' : 'lo que pagaste te cubre'} hasta el ${fechaPR(p.desde)}. Ese día se cobran ` +
             `${dinero(p.mensual)} a tu tarjeta y después cada mes.` + cola;
    if (p.credito)
      return `Hoy se cobran ${dinero(p.hoy)}: ${dinero(p.mensual)} del ${p.items[0].nombre.replace(/^Plan /, 'plan ')} menos ${dinero(p.credito)} ` +
             `por los días que te quedan del ${p.antes}. Después, ${dinero(p.mensual)} cada mes.` + cola;
    return `Hoy se cobran ${dinero(p.hoy)} a tu tarjeta y después ${dinero(p.mensual)} cada mes.` + cola;
  }

  // Decide cómo se cobra esta compra (modo, ancla, crédito) sin tocar nada.
  async function planear(n, kind, items) {
    const ahora = Date.now();
    const mensual = items.reduce((s, i) => s + i.cents, 0);
    const p = { kind, items, mensual, hoy: mensual, modo: 'nuevo', ancla: null, credito: 0 };
    if (kind === 'plan') {
      const it = items[0];
      const fin = new Date((n.status === 'trialing' ? n.trial_ends_at : n.current_period_end) || 0).getTime();
      const pagado = n.plan_code !== 'free' && fin > ahora;
      if (n.stripe_subscription_id) {
        if (it.code === n.plan_code)
          throw falla(n.cancel_at_period_end ? 'Tu plan ya está en tarjeta. Toca "Reanudar" para que se siga renovando.'
                                             : 'Tu plan ya se renueva solo con tu tarjeta.', 409);
        if (orden(it.code) < orden(n.plan_code)) throw falla('Para bajar de plan, escríbenos por WhatsApp y te ayudamos.', 409);
        const viejo = (await db.query(`SELECT price_monthly_cents FROM plans WHERE code::text = $1`, [n.plan_code])).rows[0];
        const resta = Math.max(0, Math.min(1, (fin - ahora) / MES_MS));
        p.modo = 'subir';
        p.hoy = Math.max(0, Math.round((it.cents - (viejo ? viejo.price_monthly_cents : 0)) * resta));
        p.desde = fin > ahora ? fin : null;
        return p;
      }
      if (it.code === n.plan_code && pagado && fin - ahora >= DIA_MS) {
        p.modo = 'ancla'; p.ancla = Math.floor(fin / 1000); p.desde = fin; p.hoy = 0; p.prueba = n.status === 'trialing';
      } else if (pagado && orden(it.code) < orden(n.plan_code)) {
        throw falla('Para bajar de plan, escríbenos por WhatsApp y te ayudamos.', 409);
      } else if (pagado && n.status === 'active' && it.code !== n.plan_code) {
        const viejo = (await db.query(`SELECT name, price_monthly_cents FROM plans WHERE code::text = $1`, [n.plan_code])).rows[0];
        if (viejo) {
          // Todo lo que quedaba pagado (puede ser más de un mes si pagó varios por ATH),
          // hasta dejar el cobro mínimo de Stripe.
          const c = Math.min(Math.round(viejo.price_monthly_cents * (fin - ahora) / MES_MS), it.cents - COBRO_MINIMO);
          if (c >= COBRO_MINIMO) { p.credito = c; p.hoy = it.cents - c; p.antes = 'plan ' + viejo.name; }
        }
      }
      return p;
    }
    // Add-ons: los nuevos se cobran hoy. Uno que ya está pagado por ATH pasa a tarjeta
    // solo (no mezclado con otros), con el primer cobro el día que se acaba lo pagado.
    const { rows } = await db.query(
      `SELECT code::text AS code, current_period_end, stripe_subscription_id, cancel_at_period_end
         FROM addons WHERE business_id = $1 AND code::text = ANY($2::text[]) AND status = 'active'
          AND (current_period_end IS NULL OR now() <= current_period_end + interval '7 days')`,
      [n.id, items.map(i => i.code)]);
    for (const a of rows) {
      const nombre = items.find(i => i.code === a.code).nombre;
      if (a.stripe_subscription_id)
        throw falla(a.cancel_at_period_end ? `"${nombre}" ya está en tarjeta. Toca "Reanudar" para que se siga renovando.`
                                           : `"${nombre}" ya se renueva solo con tu tarjeta.`, 409);
      if (items.length > 1) throw falla(`"${nombre}" ya está activo: pásalo a tarjeta con "Activar cobro automático" en la lista de activos.`, 409);
      const fin = new Date(a.current_period_end || 0).getTime();
      if (fin - ahora >= DIA_MS) { p.modo = 'ancla'; p.ancla = Math.floor(fin / 1000); p.desde = fin; p.hoy = 0; }
    }
    return p;
  }

  // ── El cobro: Checkout de Stripe, o el cambio de plan dentro de la suscripción ──
  async function crearCheckout(n, p) {
    const s = sdk();
    const customer = await cliente(n);
    const line_items = [];
    for (const it of p.items) line_items.push({ price: await precio(it), quantity: 1 });
    const meta = { bukeame: '1', business_id: n.id, kind: p.kind, codes: p.items.map(i => i.code).join(',') };
    const sub = { metadata: { bukeame: '1', business_id: n.id, kind: p.kind },
                  description: 'Bukéame · ' + p.items.map(i => i.nombre).join(', ') };
    if (p.ancla) {
      // Hasta casi un mes: el ancla del ciclo (Stripe no la deja a más de un periodo). Más
      // lejos (pagó varios meses por ATH): un periodo sin cobro hasta ese día.
      if (p.ancla - Date.now() / 1000 <= 27 * 86400) { sub.billing_cycle_anchor = p.ancla; sub.proration_behavior = 'none'; }
      else sub.trial_end = p.ancla;
    }
    const params = {
      mode: 'subscription', customer, client_reference_id: n.id, line_items, metadata: meta,
      subscription_data: sub, locale: 'es', payment_method_collection: 'always',
      success_url: `${BASE}/panel.html?tarjeta=ok&sesion={CHECKOUT_SESSION_ID}#cuenta`,
      cancel_url: `${BASE}/panel.html?tarjeta=no#cuenta`,
      custom_text: { submit: { message: 'El cobro se repite cada mes hasta que lo canceles en Bukéame, en Mi cuenta. ' +
        'Si cancelas, conservas lo pagado hasta su fecha.' } },
    };
    if (p.credito) {
      const cup = await s.coupons.create({
        amount_off: p.credito, currency: 'usd', duration: 'once', max_redemptions: 1,
        redeem_by: Math.floor(Date.now() / 1000) + DIA_MS / 1000,
        name: ('Lo que te queda del ' + p.antes).slice(0, 40), metadata: { business_id: n.id },
      });
      params.discounts = [{ coupon: cup.id }];
    }
    const ses = await s.checkout.sessions.create(params);
    return ses.url;
  }

  async function subirPlan(n, it) {
    const s = sdk();
    let item = n.stripe_item_id;
    let sub = await s.subscriptions.retrieve(n.stripe_subscription_id);
    if (MUERTA.includes(sub.status)) { await sincronizar(sub); throw falla('Tu plan ya no estaba en tarjeta. Intenta otra vez para ponerlo en tarjeta.', 409); }
    if (!sub.items.data.some(i => i.id === item))
      item = (sub.items.data.find(i => (deProducto(i.price && i.price.product) || {}).kind === 'plan') || {}).id;
    if (!item) throw falla('No encontramos tu plan en el cobro con tarjeta. Escríbenos por WhatsApp y lo arreglamos.', 409);
    const price = await precio(it);
    try {
      sub = await s.subscriptions.update(sub.id, {
        items: [{ id: item, price }], proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete', expand: ['latest_invoice'],
      });
    } catch (e) {
      if (e.type === 'StripeCardError') throw falla('Tu banco no aprobó el cobro. Prueba con otra tarjeta en "Tarjeta y facturas".', 402);
      throw e;
    }
    const inv = sub.latest_invoice;
    // El banco pidió confirmar el cobro: se paga en la página de la factura y el plan
    // sube cuando entre el pago (invoice.paid).
    if (sub.pending_update) {
      const url = (inv && inv.hosted_invoice_url) || null;
      return { pendiente: true, url, mensaje: url
        ? 'Tu banco pidió confirmar el cobro. Te llevamos a la página de Stripe para confirmarlo; el plan sube cuando entre el pago.'
        : 'Tu banco no aprobó el cobro y el plan no cambió. Prueba otra vez o cambia la tarjeta en "Tarjeta y facturas".' };
    }
    if (inv && typeof inv === 'object') await procesarFactura(inv);
    if (sub.cancel_at_period_end) await s.subscriptions.update(sub.id, { cancel_at_period_end: false });
    await sincronizar(sub.id);
    return { ok: true, mensaje: `Listo. Ya estás en el ${it.nombre.replace(/^Plan /, 'plan ')} y el cobro sigue saliendo de tu tarjeta.` };
  }

  // ── Lo que llega de Stripe ───────────────────────────────────────────────────
  async function esDelNegocio(bid, customer) {
    const { rows } = await db.query(`SELECT stripe_customer_id FROM subscriptions WHERE business_id = $1`, [bid]);
    if (!rows[0]) return false;
    if (!rows[0].stripe_customer_id && customer) {
      await db.query(`UPDATE subscriptions SET stripe_customer_id = $2 WHERE business_id = $1 AND stripe_customer_id IS NULL`, [bid, customer]);
      return true;
    }
    return !customer || rows[0].stripe_customer_id === customer;
  }

  // Une un renglón de la suscripción con su plan o add-on. Con `hasta` (fin del periodo
  // de una factura pagada) también da el acceso hasta ese día. Sin `hasta` solo enlaza:
  // nunca crea un add-on ni activa un plan sin pago.
  async function enlazar(bid, subId, itemId, pr, desde, hasta, monto) {
    if (pr.kind === 'plan') {
      if (hasta == null)
        return db.query(`UPDATE subscriptions SET stripe_subscription_id = $2, stripe_item_id = $3 WHERE business_id = $1`,
          [bid, subId, itemId]);
      // Mismo plan: se suma a lo que ya estaba pagado. Plan distinto: lo que quedaba del
      // plan de antes ya se descontó en el cobro (o era gratis), así que vale solo esta factura.
      return db.query(
        `UPDATE subscriptions
            SET plan_code = $2::plan_code, status = 'active', trial_ends_at = NULL,
                current_period_start = to_timestamp($5),
                current_period_end = CASE WHEN plan_code::text <> $7 THEN to_timestamp($6)
                  ELSE GREATEST(COALESCE(current_period_end, to_timestamp(0)), to_timestamp($6)) END,
                stripe_subscription_id = $3, stripe_item_id = $4
          WHERE business_id = $1`, [bid, pr.code, subId, itemId, desde, hasta, pr.code]);
    }
    if (hasta == null)
      return db.query(
        `UPDATE addons SET stripe_subscription_id = $3, stripe_item_id = $4
          WHERE business_id = $1 AND code::text = $2 AND status = 'active'`, [bid, pr.code, subId, itemId]);
    return db.query(
      `INSERT INTO addons (business_id, code, price_cents, current_period_end, stripe_subscription_id, stripe_item_id)
       VALUES ($1, $2::addon_code, COALESCE($6, (SELECT price_cents FROM addon_catalog WHERE code = $2::addon_code)),
               to_timestamp($5), $3, $4)
       ON CONFLICT (business_id, code) DO UPDATE SET
         activated_at = CASE WHEN addons.status = 'active' THEN addons.activated_at ELSE now() END,
         status = 'active', cancelled_at = NULL, price_cents = COALESCE($6, addons.price_cents),
         current_period_end = GREATEST(COALESCE(addons.current_period_end, to_timestamp(0)), to_timestamp($5)),
         stripe_subscription_id = $3, stripe_item_id = $4`,
      [bid, pr.code, subId, itemId, hasta, monto]);
  }

  async function nombres(prs) {
    const out = [];
    for (const pr of prs) {
      const q = pr.kind === 'plan'
        ? await db.query(`SELECT 'Plan ' || name AS n FROM plans WHERE code::text = $1`, [pr.code])
        : await db.query(`SELECT name AS n FROM addon_catalog WHERE code::text = $1`, [pr.code]);
      out.push(q.rows[0] ? q.rows[0].n : pr.code);
    }
    return [...new Set(out)].join(', ');
  }

  // Factura PAGADA: da el acceso hasta el fin de cada renglón, la anota en el ledger
  // (una sola vez por factura) y le avisa al dueño. Idempotente.
  async function procesarFactura(inv) {
    if (!inv || inv.status !== 'paid') return;
    const det = (inv.parent && inv.parent.subscription_details) || {};
    const subId = idDe(det.subscription) || idDe(inv.subscription);
    const md = det.metadata || {};
    if (!subId || md.bukeame !== '1' || !isUuid(md.business_id)) return;
    const bid = md.business_id;
    if (!(await esDelNegocio(bid, idDe(inv.customer)))) { console.error('tarjeta: factura de otro cliente', inv.id); return; }
    let lineas = (inv.lines && inv.lines.data) || [];
    if (inv.lines && inv.lines.has_more) lineas = (await sdk().invoices.listLineItems(inv.id, { limit: 100 })).data;
    const prs = [];
    let desde = null, hasta = null;
    for (const l of lineas) {
      if (!(l.amount >= 0)) continue;                      // el crédito por el plan de antes
      const pr = deProducto(l.pricing && l.pricing.price_details && l.pricing.price_details.product);
      const det2 = l.parent && l.parent.subscription_item_details;
      if (!pr || !det2 || !det2.subscription_item || !l.period) continue;
      await enlazar(bid, subId, det2.subscription_item, pr, l.period.start, l.period.end,
        (l.amount > 0 && !det2.proration) ? l.amount : null);
      prs.push(pr);
      desde = desde == null ? l.period.start : Math.min(desde, l.period.start);
      hasta = hasta == null ? l.period.end : Math.max(hasta, l.period.end);
    }
    if (prs.length && inv.amount_paid > 0) await registrarPago(inv, bid, subId, prs, desde, hasta);
    await sincronizar(subId);
  }

  async function registrarPago(inv, bid, subId, prs, desde, hasta) {
    const descuento = (inv.total_discount_amounts || []).reduce((s, d) => s + (d.amount || 0), 0);
    const pagado = (inv.status_transitions && inv.status_transitions.paid_at) || Math.floor(Date.now() / 1000);
    const r = await db.query(
      `INSERT INTO platform_payments
         (business_id, subscription_id, amount_cents, discount_cents, method, status, period_start, period_end, external_ref, paid_at)
       VALUES ($1, (SELECT id FROM subscriptions WHERE business_id = $1 AND stripe_subscription_id = $2),
               $3, $4, 'card', 'paid', (to_timestamp($5) AT TIME ZONE '${PR_TZ}')::date,
               (to_timestamp($6) AT TIME ZONE '${PR_TZ}')::date, $7, to_timestamp($8))
       ON CONFLICT (external_ref) WHERE method = 'card' AND external_ref IS NOT NULL DO NOTHING
       RETURNING id`, [bid, subId, inv.amount_paid, descuento, desde, hasta, inv.id, pagado]);
    if (!r.rows[0]) return;                                // ya se había anotado
    const titulo = await nombres(prs);
    try {
      await notify(bid, 'payment', 'Pago recibido',
        `Recibimos tu pago de ${dinero(inv.amount_paid)} con tarjeta (${titulo}). ¡Gracias!`, { kind: 'tarjeta' });
      const u = (await db.query(
        `SELECT u.email FROM businesses b JOIN users u ON u.id = b.owner_user_id WHERE b.id = $1`, [bid])).rows[0];
      if (u && u.email && typeof emailPlatformReceipt === 'function') {
        const e = emailPlatformReceipt({ title: titulo, amountCents: inv.amount_paid, method: 'Tarjeta', reference: inv.number || inv.id });
        sendEmail(u.email, e.subject, e.text, e.html).catch(err => console.error('tarjeta recibo:', err.message));
      }
    } catch (e) { console.error('tarjeta aviso de pago:', e.message); }
  }

  // Copia el estado de la suscripción en lo que ya está enlazado a ella. Nunca da
  // acceso: solo la cancelación, el pago atrasado y los renglones que ya no están.
  async function sincronizar(subOrId) {
    const sub = typeof subOrId === 'string' ? await sdk().subscriptions.retrieve(subOrId) : subOrId;
    if (!sub || !sub.metadata || sub.metadata.bukeame !== '1' || !isUuid(sub.metadata.business_id)) return;
    const bid = sub.metadata.business_id;
    // "unpaid": Stripe dejó de intentar pero no la canceló. Se cancela, para que el dueño
    // pueda pagar por ATH o poner otra tarjeta (si no, quedaría trabado en las dos).
    if (sub.status === 'unpaid') {
      try { await sdk().subscriptions.cancel(sub.id); } catch (e) { console.error('tarjeta cancelar unpaid:', e.message); }
    }
    const viva = !MUERTA.includes(sub.status) && sub.status !== 'unpaid';
    const cancela = !viva || !!sub.cancel_at_period_end || !!sub.cancel_at;
    const vivos = viva ? sub.items.data.map(i => i.id) : [];
    const atrasada = ['past_due', 'unpaid'].includes(sub.status);
    // Lo que salió de la suscripción (renglón borrado o suscripción terminada) queda
    // sin renovar: se conserva hasta su fecha y después lo baja el worker.
    await db.query(
      `UPDATE addons SET stripe_subscription_id = NULL, stripe_item_id = NULL, cancel_at_period_end = true
        WHERE business_id = $1 AND stripe_subscription_id = $2 AND NOT (COALESCE(stripe_item_id, '') = ANY($3::text[]))`,
      [bid, sub.id, vivos]);
    await db.query(
      `UPDATE addons SET cancel_at_period_end = $3
        WHERE business_id = $1 AND stripe_subscription_id = $2`, [bid, sub.id, cancela]);
    await db.query(
      `UPDATE subscriptions SET stripe_subscription_id = NULL, stripe_item_id = NULL, cancel_at_period_end = true,
              status = CASE WHEN status = 'past_due' THEN 'active' ELSE status END
        WHERE business_id = $1 AND stripe_subscription_id = $2 AND NOT (COALESCE(stripe_item_id, '') = ANY($3::text[]))`,
      [bid, sub.id, vivos]);
    await db.query(
      `UPDATE subscriptions SET cancel_at_period_end = $3,
              status = CASE WHEN $4 AND status = 'active' THEN 'past_due'
                            WHEN NOT $4 AND status = 'past_due' THEN 'active' ELSE status END
        WHERE business_id = $1 AND stripe_subscription_id = $2`, [bid, sub.id, cancela, atrasada]);
  }

  // Checkout terminado: si hubo factura pagada, da el acceso; si hoy no se cobraba nada
  // (paso a tarjeta de algo ya pagado), solo enlaza.
  async function alCompletar(ses) {
    if (!ses || ses.mode !== 'subscription' || !ses.metadata || ses.metadata.bukeame !== '1') return;
    const bid = ses.metadata.business_id;
    if (!isUuid(bid) || ses.status !== 'complete' || !ses.subscription) return;
    if (!(await esDelNegocio(bid, idDe(ses.customer)))) return;
    const full = (ses.invoice && typeof ses.invoice === 'object') ? ses
      : await sdk().checkout.sessions.retrieve(ses.id, { expand: ['invoice'] });
    const pagada = !!(full.invoice && typeof full.invoice === 'object' && full.invoice.status === 'paid');
    if (pagada) await procesarFactura(full.invoice);
    else if (full.payment_status !== 'no_payment_required') return;
    // Una factura de $0 (paso a tarjeta) puede venir sin renglones: se enlaza por la suscripción.
    const sub = await sdk().subscriptions.retrieve(idDe(full.subscription));
    for (const it of sub.items.data) {
      const pr = deProducto(it.price && it.price.product);
      if (pr) await enlazar(bid, sub.id, it.id, pr, null, null, null);
    }
    await sincronizar(sub);
  }

  async function avisarFallo(inv) {
    const det = (inv.parent && inv.parent.subscription_details) || {};
    const subId = idDe(det.subscription) || idDe(inv.subscription);
    const md = det.metadata || {};
    if (!subId || md.bukeame !== '1' || !isUuid(md.business_id)) return;
    // Si ya no hay nada enlazado (quitó la tarjeta o canceló), no se le avisa. Se mira
    // ANTES de copiar el estado: tras el último intento Stripe puede cancelarla enseguida.
    const enlazado = await db.query(
      `SELECT 1 FROM subscriptions WHERE stripe_subscription_id = $1
        UNION ALL SELECT 1 FROM addons WHERE stripe_subscription_id = $1 LIMIT 1`, [subId]);
    await sincronizar(subId);
    // Solo las renovaciones: el cambio de plan falla en pantalla, con el dueño ahí.
    if (inv.billing_reason !== 'subscription_cycle') return;
    if (!enlazado.rows[0]) return;
    const ultimo = !inv.next_payment_attempt;
    if (inv.attempt_count !== 1 && !ultimo) return;          // avisa al primer intento y al último
    const monto = dinero(inv.amount_due);
    const body = ultimo
      ? `No pudimos cobrar ${monto} a tu tarjeta y ya no lo vamos a intentar más. Para no perder el servicio, págalo desde Mi cuenta en bukeame.com, con tarjeta o con ATH Móvil.`
      : `No pudimos cobrar ${monto} a tu tarjeta. Lo volvemos a intentar en los próximos días. Si cambiaste de tarjeta o se venció, actualízala en bukeame.com: Mi cuenta, "Tarjeta y facturas".`;
    await alertOwner(md.business_id, null, {
      type: 'payment', title: 'No pudimos cobrar tu tarjeta', body, template: 'owner_card_failed',
      wa: `*Bukéame* — No pudimos cobrar tu tarjeta\n\n${body}`,
    });
  }

  // ── Lo que usan los otros módulos ────────────────────────────────────────────
  async function filaDe(bid, kind, code) {
    try {
      const q = kind === 'plan'
        ? await db.query(`SELECT stripe_subscription_id AS sub, stripe_item_id AS item, cancel_at_period_end AS cancela FROM subscriptions WHERE business_id = $1`, [bid])
        : await db.query(`SELECT stripe_subscription_id AS sub, stripe_item_id AS item, cancel_at_period_end AS cancela FROM addons WHERE business_id = $1 AND code::text = $2`, [bid, code]);
      return q.rows[0] || null;
    } catch (e) {
      if (e.code === '42703') return null;     // sin la migración 37 no hay nada en tarjeta
      throw e;
    }
  }

  // Cancelar la renovación con tarjeta (el beneficio sigue hasta el fin de lo pagado).
  // Si el add-on comparte suscripción con otros, se quita su renglón; si va solo, la
  // suscripción se cancela al final del periodo. Lanza error si Stripe no responde.
  async function cancelarRenovacion(bid, kind, code) {
    const f = await filaDe(bid, kind, code);
    if (!f || !f.sub) return false;
    if (!KEY) throw new Error('Stripe sin llave');
    const s = sdk();
    const sub = await s.subscriptions.retrieve(f.sub);
    if (!MUERTA.includes(sub.status) && sub.items.data.some(i => i.id === f.item)) {
      if (sub.items.data.length > 1) await s.subscriptionItems.del(f.item, { proration_behavior: 'none' });
      else if (!sub.cancel_at_period_end) await s.subscriptions.update(sub.id, { cancel_at_period_end: true });
    }
    await sincronizar(sub.id);
    return true;
  }

  // "Quitar mi tarjeta": ningún cobro automático más y la tarjeta se borra de Stripe.
  // Lo pagado se respeta: cada suscripción se cancela al final de su periodo (la que tiene
  // un pago atrasado, ya), y en Bukéame todo queda como pagado a mano hasta su fecha.
  async function quitarTarjeta(bid) {
    const r = await db.query(`SELECT stripe_customer_id FROM subscriptions WHERE business_id = $1`, [bid]);
    const cus = r.rows[0] && r.rows[0].stripe_customer_id;
    if (!cus) return { cobros: 0, tarjetas: 0 };
    const s = sdk();
    const subs = await s.subscriptions.list({ customer: cus, status: 'all', limit: 100 });
    let cobros = 0;
    for (const sub of subs.data) {
      if (MUERTA.includes(sub.status)) continue;
      cobros++;
      if (['past_due', 'unpaid'].includes(sub.status)) await s.subscriptions.cancel(sub.id);
      else if (!sub.cancel_at_period_end) await s.subscriptions.update(sub.id, { cancel_at_period_end: true });
    }
    const pms = await s.customers.listPaymentMethods(cus, { limit: 100 });
    for (const pm of pms.data) await s.paymentMethods.detach(pm.id);
    await db.query(
      `UPDATE addons SET stripe_subscription_id = NULL, stripe_item_id = NULL, cancel_at_period_end = true
        WHERE business_id = $1 AND stripe_subscription_id IS NOT NULL`, [bid]);
    await db.query(
      `UPDATE subscriptions SET stripe_subscription_id = NULL, stripe_item_id = NULL, cancel_at_period_end = true,
              status = CASE WHEN status = 'past_due' THEN 'active' ELSE status END
        WHERE business_id = $1 AND stripe_subscription_id IS NOT NULL`, [bid]);
    return { cobros, tarjetas: pms.data.length };
  }

  // Para borrar la cuenta: ningún cobro con tarjeta sigue vivo.
  async function cancelarTodo(bid) {
    const r = await db.query(`SELECT stripe_customer_id FROM subscriptions WHERE business_id = $1`, [bid]);
    const cus = r.rows[0] && r.rows[0].stripe_customer_id;
    if (!cus) return;
    if (!KEY) throw new Error('Stripe sin llave');
    const subs = await sdk().subscriptions.list({ customer: cus, status: 'all', limit: 100 });
    for (const s of subs.data) if (!MUERTA.includes(s.status)) await sdk().subscriptions.cancel(s.id);
  }

  // Lo que ya se renueva solo con tarjeta no se vuelve a pagar por ATH.
  async function bloqueaAth(bid, kind, code, codes) {
    if (kind === 'plan') {
      const f = await filaDe(bid, 'plan');
      return (f && f.sub && !f.cancela) ? 'Tu plan ya se renueva solo con tu tarjeta. Para cambiar de plan, toca "Cambiar a este plan" y se cobra a la misma tarjeta.' : null;
    }
    const pedidos = kind === 'addons' ? (codes || []) : [code];
    try {
      const { rows } = await db.query(
        `SELECT c.name FROM addons a JOIN addon_catalog c ON c.code = a.code
          WHERE a.business_id = $1 AND a.code::text = ANY($2::text[]) AND a.stripe_subscription_id IS NOT NULL
            AND NOT a.cancel_at_period_end LIMIT 1`, [bid, pedidos]);
      return rows[0] ? `"${rows[0].name}" ya se renueva solo con tu tarjeta.` : null;
    } catch (e) {
      if (e.code === '42703') return null;
      throw e;
    }
  }

  // Por si se perdió un webhook: lo que está en tarjeta y vence en menos de 12 horas
  // (o ya venció) se revisa contra Stripe.
  async function conciliar() {
    if (!lista()) return;
    const { rows } = await db.query(
      `SELECT DISTINCT sub FROM (
         SELECT stripe_subscription_id AS sub, current_period_end AS fin FROM subscriptions WHERE stripe_subscription_id IS NOT NULL
         UNION ALL
         SELECT stripe_subscription_id, current_period_end FROM addons WHERE stripe_subscription_id IS NOT NULL AND status = 'active'
       ) x WHERE fin IS NULL OR fin < now() + interval '12 hours' LIMIT 50`);
    for (const r of rows) {
      try {
        const sub = await sdk().subscriptions.retrieve(r.sub, { expand: ['latest_invoice'] });
        if (sub.latest_invoice && typeof sub.latest_invoice === 'object') await procesarFactura(sub.latest_invoice);
        await sincronizar(sub);
      } catch (e) { console.error('tarjeta conciliar:', e.message); }
    }
  }

  // El portal de Stripe (cambiar tarjeta, facturas, cancelar). Se configura solo la
  // primera vez: cancelar al final del periodo, sin pausar ni cambiar de plan allí.
  let portalCfg = null;
  async function configuracionPortal() {
    if (portalCfg) return portalCfg;
    const s = sdk();
    const hay = await s.billingPortal.configurations.list({ active: true, limit: 100 });
    const nuestra = hay.data.find(c => c.metadata && c.metadata.bukeame === '1');
    portalCfg = nuestra ? nuestra.id : (await s.billingPortal.configurations.create({
      name: 'Bukéame', metadata: { bukeame: '1' }, default_return_url: `${BASE}/panel.html#cuenta`,
      business_profile: { headline: 'Bukéame · tu mensualidad', privacy_policy_url: `${BASE}/privacidad.html`,
                          terms_of_service_url: `${BASE}/terminos.html` },
      features: {
        payment_method_update: { enabled: true }, invoice_history: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
        subscription_update: { enabled: false }, subscription_pause: { enabled: false },
        customer_update: { enabled: false },
      },
    }, { idempotencyKey: 'bk-portal-v1' })).id;
    return portalCfg;
  }

  // ==========================================================================
  //  RUTAS DEL PANEL
  // ==========================================================================
  app.get('/api/billing/tarjeta/config', ...PANEL, asyncH(async (req, res) => {
    const r = await db.query(`SELECT stripe_customer_id FROM subscriptions WHERE business_id = $1`, [req.business.id]);
    const ok = paraNegocio(req.business.id);
    res.json({ enabled: ok, portal: ok && !!(r.rows[0] && r.rows[0].stripe_customer_id) });
  }));

  // body: { kind: 'plan', code } | { kind: 'addons', codes: [...] }, y vista:true para
  // solo leer lo que se va a cobrar. → { aviso } | { url } (a Stripe) | { ok, mensaje }
  app.post('/api/billing/tarjeta/checkout', ...PANEL, asyncH(async (req, res) => {
    if (!paraNegocio(req.business.id)) return bad(res, NO_DISPONIBLE, 503);
    const kind = req.body && req.body.kind;
    if (!['plan', 'addons'].includes(kind)) return bad(res, 'No pudimos preparar el cobro. Recarga la página e intenta de nuevo.');
    const n = await negocio(req.business.id);
    if (!n || !n.sub_row) return bad(res, 'No encontramos el plan de tu negocio. Escríbenos por WhatsApp y lo arreglamos.', 404);
    let p;
    try { p = await planear(n, kind, await articulos(n, kind, req.body)); }
    catch (e) { if (e.userMsg) return bad(res, e.userMsg, e.httpStatus); throw e; }
    if (req.body.vista) return res.json({ aviso: aviso(p), hoy_cents: p.hoy, mensual_cents: p.mensual, modo: p.modo });
    try {
      if (p.modo === 'subir') {
        const r = await subirPlan(n, p.items[0]);
        await audit(req, 'billing.card.upgrade', 'business', n.id, { plan_code: p.items[0].code });
        return res.json(r);
      }
      const url = await crearCheckout(n, p);
      await audit(req, 'billing.card.checkout', 'business', n.id,
        { kind, codes: p.items.map(i => i.code), hoy_cents: p.hoy, modo: p.modo });
      res.json({ url });
    } catch (e) {
      if (e.userMsg) return bad(res, e.userMsg, e.httpStatus);
      console.error('tarjeta checkout:', e.message);
      return bad(res, 'No pudimos abrir el pago con tarjeta. Intenta de nuevo en un rato.', 502);
    }
  }));

  // Al volver de Stripe: confirma la sesión sin esperar el webhook.
  app.get('/api/billing/tarjeta/estado', ...PANEL, asyncH(async (req, res) => {
    if (!paraNegocio(req.business.id)) return bad(res, NO_DISPONIBLE, 503);
    const id = String(req.query.sesion || '');
    if (!/^cs_[A-Za-z0-9_]{6,250}$/.test(id)) return bad(res, 'Sesión inválida');
    let ses;
    try { ses = await sdk().checkout.sessions.retrieve(id, { expand: ['invoice'] }); }
    catch (e) {
      if (e.code === 'resource_missing') return bad(res, 'Sesión no encontrada', 404);
      console.error('tarjeta estado:', e.message);
      return bad(res, 'Stripe no respondió', 502);
    }
    if (!ses.metadata || ses.metadata.bukeame !== '1' || ses.metadata.business_id !== req.business.id)
      return bad(res, 'Sesión no encontrada', 404);
    if (ses.status !== 'complete') return res.json({ listo: false, estado: ses.status });
    await alCompletar(ses);
    res.json({ listo: true, kind: ses.metadata.kind,
      mensaje: ses.payment_status === 'no_payment_required'
        ? 'Listo. Hoy no se cobró nada: el primer cobro a tu tarjeta es cuando se acabe tu prueba o lo que ya pagaste.'
        : 'Listo, recibimos tu pago. El cobro se repite solo cada mes con tu tarjeta.' });
  }));

  // Deshace "Cancelar" mientras la suscripción sigue viva. Si el add-on iba con otros
  // que también estaban cancelados, solo se reanuda este: a los demás se les quita el renglón.
  app.post('/api/billing/tarjeta/reanudar', ...PANEL, asyncH(async (req, res) => {
    if (!paraNegocio(req.business.id)) return bad(res, NO_DISPONIBLE, 503);
    const kind = req.body && req.body.kind === 'plan' ? 'plan' : 'addon';
    const code = kind === 'addon' ? String(req.body.code || '') : null;
    if (kind === 'addon' && !isStr(code, 60)) return bad(res, 'No pudimos preparar el cobro. Recarga la página e intenta de nuevo.');
    const f = await filaDe(req.business.id, kind, code);
    if (!f || !f.sub) return bad(res, 'Ya no está en tarjeta. Usa "Activar cobro automático".', 409);
    const s = sdk();
    let sub;
    try {
      sub = await s.subscriptions.retrieve(f.sub);
      if (MUERTA.includes(sub.status) || !sub.items.data.some(i => i.id === f.item)) {
        await sincronizar(sub);
        return bad(res, 'Ya no está en tarjeta. Usa "Activar cobro automático".', 409);
      }
      if (sub.cancel_at_period_end || sub.cancel_at) {
        await s.subscriptions.update(sub.id, sub.cancel_at_period_end ? { cancel_at_period_end: false } : { cancel_at: '' });
        for (const it of sub.items.data)
          if (it.id !== f.item) await s.subscriptionItems.del(it.id, { proration_behavior: 'none' });
      }
      await sincronizar(sub.id);
    } catch (e) {
      console.error('tarjeta reanudar:', e.message);
      return bad(res, 'Stripe no respondió. Intenta de nuevo en un rato.', 502);
    }
    await audit(req, 'billing.card.resume', 'business', req.business.id, { kind, code });
    res.json({ ok: true });
  }));

  app.post('/api/billing/tarjeta/quitar', ...PANEL, asyncH(async (req, res) => {
    if (!paraNegocio(req.business.id)) return bad(res, NO_DISPONIBLE, 503);
    let r;
    try { r = await quitarTarjeta(req.business.id); }
    catch (e) {
      console.error('tarjeta quitar:', e.message);
      return bad(res, 'Stripe no respondió. Intenta de nuevo en un rato.', 502);
    }
    await audit(req, 'billing.card.remove', 'business', req.business.id, r);
    res.json({ ok: true, ...r });
  }));

  app.post('/api/billing/tarjeta/portal', ...PANEL, asyncH(async (req, res) => {
    if (!paraNegocio(req.business.id)) return bad(res, NO_DISPONIBLE, 503);
    const r = await db.query(`SELECT stripe_customer_id FROM subscriptions WHERE business_id = $1`, [req.business.id]);
    const cus = r.rows[0] && r.rows[0].stripe_customer_id;
    if (!cus) return bad(res, 'Todavía no tienes cobros con tarjeta', 404);
    try {
      const ses = await sdk().billingPortal.sessions.create({
        customer: cus, configuration: await configuracionPortal(), locale: 'es',
        return_url: `${BASE}/panel.html?tarjeta=portal#cuenta`,
      });
      res.json({ url: ses.url });
    } catch (e) {
      console.error('tarjeta portal:', e.message);
      return bad(res, 'No pudimos abrir la página de Stripe. Intenta de nuevo en un rato.', 502);
    }
  }));

  // ==========================================================================
  //  WEBHOOK DE STRIPE (endpoint de la cuenta, no el de Connect)
  //  Firma inválida → 400. Error al procesar → 500 y Stripe reintenta (todo es idempotente).
  // ==========================================================================
  app.post('/api/billing/stripe/webhook', asyncH(async (req, res) => {
    if (!lista()) return res.status(503).json({ error: 'Webhook no configurado' });
    if (!Buffer.isBuffer(req.body)) { console.error('tarjeta webhook: el cuerpo no llegó crudo'); return res.status(400).json({ error: 'Cuerpo inválido' }); }
    let ev;
    try { ev = sdk().webhooks.constructEvent(req.body, req.get('stripe-signature') || '', WH); }
    catch (_e) { return res.status(400).json({ error: 'Firma inválida' }); }
    const o = (ev.data && ev.data.object) || {};
    switch (ev.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await alCompletar(o); break;
      // La factura se vuelve a pedir con la versión del SDK: así no importa con qué versión
      // de la API se creó el endpoint en Stripe (la forma de la factura cambia entre versiones).
      case 'invoice.paid':
        if (o.id) await procesarFactura(await sdk().invoices.retrieve(o.id));
        break;
      case 'invoice.payment_failed':
        if (o.id) await avisarFallo(await sdk().invoices.retrieve(o.id));
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed':
        if (o.metadata && o.metadata.bukeame === '1') await sincronizar(o.id);
        break;
      default: break;
    }
    res.json({ received: true });
  }));

  console.log(lista() ? `  ✓ módulo cobro con tarjeta montado (Stripe Billing${PILOTO.size ? ', solo piloto: ' + PILOTO.size + ' negocio(s)' : ''})`
                      : '  · cobro con tarjeta apagado (faltan STRIPE_SECRET_KEY o STRIPE_BILLING_WEBHOOK_SECRET)');
  return { lista, cancelarRenovacion, cancelarTodo, quitarTarjeta, bloqueaAth, conciliar };
}

module.exports = { mount };
