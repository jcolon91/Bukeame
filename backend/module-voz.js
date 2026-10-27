// ============================================================================
//  BUKEAME API — módulo VOZ: recepcionista IA por teléfono (Retell AI)
// ----------------------------------------------------------------------------
//  Retell contesta la llamada y, para ver horas o reservar, llama estas rutas como
//  "custom functions" (POST, JSON con los argumentos al tope: opción "args only").
//  Por dentro usan las MISMAS rutas públicas de la web (/api/public/:slug/...), así
//  que la reserva por teléfono pasa por las mismas validaciones, depósitos y avisos
//  de WhatsApp que una reserva en línea. Aquí solo se traduce para la IA: horas en
//  hora de PR y mensajes cortos en español.
//
//  Seguridad: cada pedido trae el encabezado X-Bukeame-Voz con la llave del .env
//  (RETELL_VOZ_KEY), y solo funcionan los negocios en VOZ_SLUGS (piloto). Sin la
//  llave en el .env, todo responde "no activada".
// ============================================================================

const crypto = require('crypto');
const PR_TZ = 'America/Puerto_Rico';

function horaPR(iso) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: PR_TZ, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(iso));
  const g = (t) => (p.find((x) => x.type === t) || {}).value || '';
  return `${g('hour')}:${g('minute')} ${g('dayPeriod').toLowerCase() === 'am' ? 'de la mañana' : 'de la tarde'}`;
}
const fechaPR = (iso) => new Date(iso).toLocaleDateString('es-PR', { timeZone: PR_TZ, weekday: 'long', day: 'numeric', month: 'long' });
const minDelDiaPR = (iso) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: PR_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  return Number((p.find((x) => x.type === 'hour') || {}).value) * 60 + Number((p.find((x) => x.type === 'minute') || {}).value);
};
const dinero = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;

module.exports.mount = function (app, ctx) {
  const { db, h, port } = ctx;
  const { asyncH, isUuid, isDate, isStr, isPhone, normPhone, alertOwner, oneLine } = h;
  const BASE = `http://127.0.0.1:${port}/api/public`;

  // Llave y negocios del piloto
  function guard(req, res, next) {
    const key = process.env.RETELL_VOZ_KEY || '';
    const slugs = String(process.env.VOZ_SLUGS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!key) return res.status(503).json({ error: 'La recepcionista IA no está activada.' });
    const got = String(req.get('x-bukeame-voz') || '');
    const ok = got.length === key.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key));
    if (!ok) return res.status(401).json({ error: 'No autorizado.' });
    if (!slugs.includes(req.params.slug)) return res.status(403).json({ error: 'Este negocio no tiene la recepcionista IA.' });
    next();
  }

  // Llamada a la ruta pública de la web (loopback): misma validación que una reserva en línea.
  async function pub(path, opts = {}) {
    const r = await fetch(BASE + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
    let data = {};
    try { data = await r.json(); } catch (_e) {}
    return { ok: r.ok, status: r.status, data };
  }

  // 1) Servicios, equipo, horario y reglas del negocio (lo primero que consulta la IA)
  app.post('/api/voz/:slug/servicios', guard, asyncH(async (req, res) => {
    const r = await pub(`/${encodeURIComponent(req.params.slug)}`);
    if (!r.ok) return res.json({ error: 'No pude ver la información del negocio ahora mismo.' });
    const { business: b, services = [], staff = [], hours = [] } = r.data;
    const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    const hora12 = (t) => { const [hh, mm] = String(t).split(':').map(Number); return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`; };
    res.json({
      negocio: b.name,
      direccion: oneLine([b.address_line, b.municipality].filter(Boolean).join(', ')),
      cobra_deposito: !!b.deposits_enabled,
      cancelacion: b.cancellation_hours ? `Se cancela con al menos ${b.cancellation_hours} horas de anticipación.` : null,
      horario: dias.map((d, i) => {
        const hs = hours.filter((x) => Number(x.day_of_week) === i);
        return `${d}: ${hs.length ? hs.map((x) => `${hora12(x.opens)} a ${hora12(x.closes)}`).join(' y ') : 'cerrado'}`;
      }),
      servicios: services.map((s) => {
        // Misma cuenta que la reserva en línea (server.js): depósito del servicio o el general del negocio
        const dep = b.deposits_enabled ? (s.deposit_cents || b.deposit_default_cents || 0) : 0;
        return { id: s.id, nombre: s.name, minutos: s.duration_min, precio: dinero(s.price_cents), deposito: dep ? dinero(dep) : 'no lleva' };
      }),
      barberos: staff.map((s) => ({ id: s.id, nombre: s.display_name })),
    });
  }));

  // 2) Horas libres de un día. Devuelve pocas y en hora de PR (la IA las dice en voz alta).
  app.post('/api/voz/:slug/horas', guard, asyncH(async (req, res) => {
    const { service_id, fecha, staff_id, hora_preferida, parte_del_dia } = req.body || {};
    if (!isUuid(service_id)) return res.json({ error: 'Falta el servicio (usa el id de la lista de servicios).' });
    if (!isDate(fecha)) return res.json({ error: 'La fecha debe venir como AAAA-MM-DD.' });
    let q = `/${encodeURIComponent(req.params.slug)}/availability?service_id=${service_id}&date=${fecha}`;
    if (isUuid(staff_id)) q += `&staff_id=${staff_id}`;
    const r = await pub(q);
    if (!r.ok) return res.json({ error: r.data.error || 'No pude ver las horas ahora mismo.' });
    let slots = (r.data.slots || []).filter((s) => String(s).includes('T'));
    const total = slots.length;
    if (!total) {
      return res.json({ fecha: fecha, horas: [], mensaje: r.data.reason === 'fuera_de_horizonte'
        ? 'Esa fecha está muy adelante; todavía no se puede reservar.' : 'Ese día no quedan horas para ese servicio.' });
    }
    if (parte_del_dia === 'mañana') slots = slots.filter((s) => minDelDiaPR(s) < 12 * 60);
    else if (parte_del_dia === 'tarde') slots = slots.filter((s) => minDelDiaPR(s) >= 12 * 60 && minDelDiaPR(s) < 17 * 60);
    else if (parte_del_dia === 'noche') slots = slots.filter((s) => minDelDiaPR(s) >= 17 * 60);
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hora_preferida || ''));
    if (m) {
      const want = Number(m[1]) * 60 + Number(m[2]);
      slots = slots.slice().sort((a, b) => Math.abs(minDelDiaPR(a) - want) - Math.abs(minDelDiaPR(b) - want)).slice(0, 4)
        .sort((a, b) => new Date(a) - new Date(b));
    }
    const pocas = slots.slice(0, 6);
    if (!pocas.length) {
      return res.json({ fecha: fechaPR(r.data.slots.find((s) => String(s).includes('T'))), horas: [],
        mensaje: `A esa hora o en esa parte del día no queda nada, pero ese día hay ${total} horas en otro momento. Pregunta si le sirve otra hora.` });
    }
    res.json({
      fecha: fechaPR(pocas[0] || r.data.slots[0]),
      horas: pocas.map((s) => ({ hora: horaPR(s), start_iso: s })),
      quedan_mas: Math.max(0, total - pocas.length),
      nota: 'Para reservar usa el start_iso exacto de la hora que escoja el cliente.',
    });
  }));

  // 3) Reservar (misma ruta pública: valida el turno, cobra depósito si aplica y manda el WhatsApp)
  app.post('/api/voz/:slug/reservar', guard, asyncH(async (req, res) => {
    const { service_id, start_iso, nombre, telefono, staff_id, nota } = req.body || {};
    if (!isUuid(service_id) || !isStr(start_iso, 40)) return res.json({ error: 'Faltan el servicio o la hora.' });
    if (!isStr(nombre, 120)) return res.json({ error: 'Falta el nombre del cliente.' });
    const tel = String(telefono || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (!isPhone(tel)) return res.json({ error: 'El teléfono debe tener 10 dígitos.' });
    const body = { service_id, start_iso, full_name: nombre.trim(), phone: tel,
      client_notes: (isStr(nota, 300) ? nota.trim() + ' · ' : '') + 'Reservada por teléfono (recepcionista IA)' };
    if (isUuid(staff_id)) body.staff_id = staff_id;
    const r = await pub(`/${encodeURIComponent(req.params.slug)}/appointments`, { method: 'POST', body });
    if (!r.ok) return res.json({ ok: false, error: r.data.error || 'No se pudo reservar. Ofrece otra hora.' });
    const a = r.data.appointment || {};
    const pendiente = a.status === 'pending_deposit';
    res.json({
      ok: true,
      codigo: a.confirmation_code,
      servicio: a.service_name,
      cuando: `${fechaPR(a.starts_at)} a las ${horaPR(a.starts_at)}`,
      barbero: a.staff_name || null,
      decir_al_cliente: pendiente
        ? `Quedó reservada, pendiente del depósito de ${dinero(a.deposit_cents)}. Le llega un WhatsApp con el enlace para pagarlo; tiene 30 minutos o el turno se libera.`
        : 'Quedó confirmada. Le llega un WhatsApp con la confirmación y el enlace de su cita.',
    });
  }));

  // 4) Dejar un mensaje al dueño (lo que la IA no puede resolver): in-app + WhatsApp/email
  app.post('/api/voz/:slug/mensaje', guard, asyncH(async (req, res) => {
    const { nombre, telefono, mensaje } = req.body || {};
    if (!isStr(mensaje, 600)) return res.json({ error: 'Falta el mensaje.' });
    const biz = (await db.query(`SELECT id FROM businesses WHERE slug = $1 AND deleted_at IS NULL`, [req.params.slug])).rows[0];
    if (!biz) return res.json({ error: 'Negocio no encontrado.' });
    const tel = String(telefono || '').replace(/\D/g, '').slice(-10);
    const quien = oneLine(isStr(nombre, 120) ? nombre : 'Un cliente') + (tel.length === 10 ? ` (${normPhone(tel)})` : '');
    const detalle = oneLine(`${quien}: ${mensaje}`).slice(0, 400);
    await alertOwner(biz.id, null, {
      type: 'system', title: 'Mensaje de la recepcionista IA', body: detalle, template: 'owner_voice_msg',
      wa: `*Bukéame* — Mensaje de una llamada\n\n${detalle}\n\n(Lo tomó la recepcionista IA. Llama o escribe al cliente.)`,
    });
    res.json({ ok: true, decir_al_cliente: 'Listo, le dejé el mensaje al negocio. Te van a contactar.' });
  }));

  console.log('  ✓ módulo voz montado (recepcionista IA por teléfono)');
};
