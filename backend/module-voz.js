// ============================================================================
//  BUKEAME API — módulo VOZ: add-on RECEPCIONISTA IA (llamadas con Retell AI)
// ----------------------------------------------------------------------------
//  Un solo agente plantilla en Retell (retell-plantilla.js) atiende a todos los
//  negocios que tienen el add-on 'ai_receptionist'. Cada negocio tiene su propio
//  número de Retell (voice_lines); el dueño desvía a ese número las llamadas que
//  no coge.
//
//  Lo que Retell llama aquí:
//    POST /api/voz/entrante      → webhook de entrada: ¿de qué negocio es este número?
//                                  Devuelve sus variables (nombre, preguntas frecuentes,
//                                  modo…) y su voz, o RECHAZA la llamada.
//    POST /api/voz/fn/:fn        → funciones durante la llamada (info_negocio,
//                                  buscar_horas, reservar_cita, dejar_mensaje). Usan las
//                                  MISMAS rutas públicas de la web (loopback), así que la
//                                  reserva por teléfono pasa por las mismas validaciones,
//                                  depósitos y avisos de WhatsApp que una en línea.
//    POST /api/voz/eventos       → fin de llamada: duración, costo, resumen, grabación.
//
//  Lo que usa el panel (recepcionista.html):
//    GET/PUT /api/voice, POST /api/voice/line, GET /api/voice/calls[/:id/recording]
//
//  Costo (lo paga Wifnix): el webhook de entrada FALLA CERRADO. Ante cualquier error,
//  firma mala o falta de configuración contesta "rechazar", y los números se compran
//  SIN agente fijo, así que si Bukéame no contesta, Retell cuelga en vez de conectar.
//  Los minutos se cuentan por periodo pagado del add-on, las llamadas en curso
//  cuentan completas, y hay tope de llamadas simultáneas, de repetidas y de citas y
//  mensajes por llamada.
//
//  Seguridad: los webhooks traen la firma x-retell-signature (HMAC con la API key de
//  Retell); las funciones traen el encabezado X-Bukeame-Voz (RETELL_VOZ_KEY). Ninguna
//  llave va en una URL. El negocio SIEMPRE sale de la llamada registrada por el webhook
//  de entrada (call_id), nunca de lo que mande la IA.
// ============================================================================

const crypto = require('crypto');
const PR_TZ = 'America/Puerto_Rico';
const ADDON = 'ai_receptionist';
const MAX_FAQ = 12;
const MAX_MIN_LLAMADA = 10;        // minutos máximos de una llamada normal
const POR_LLAMADA = 2;             // citas y mensajes máximos por llamada
const AVISO = 'Te atiende la recepcionista virtual, que es una inteligencia artificial, y esta llamada se graba para darte un mejor servicio. ¿En qué te puedo ayudar?';
// Códigos de área que no se aceptan para pasar llamadas: tarifa especial y países del
// Caribe que comparten el +1 (la llamada saliente la paga Wifnix).
const AREAS_BLOQUEADAS = new Set(['900', '976', '242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664',
  '721', '758', '767', '784', '809', '829', '849', '868', '869', '876']);

// Tipo de negocio (slug de la categoría) → cómo se nombra y cómo hablan sus clientes
const TIPOS = {
  barberia: ['una barbería', 'dicen "pelarme", "recorte", "fade", "taper", "line up", "blowout" o "arreglarme la barba".'],
  salon: ['un salón de belleza', 'dicen "blower", "secado", "tinte", "mechas", "balayage", "keratina", "alisado" o "recorte de puntas".'],
  unas: ['un salón de uñas', 'dicen "acrílico", "gel", "polish", "mani", "pedi", "relleno" o "fill", y "diseño".'],
  estetica: ['un centro de estética', 'dicen "facial", "limpieza", "peeling", "microblading" o "depilación".'],
  lashes: ['un estudio de pestañas y cejas', 'dicen "extensiones", "clásicas", "volumen", "lifting", "relleno", "laminado de cejas".'],
  spa: ['un spa', 'dicen "masaje", "descontracturante", "piedras calientes", "masaje en pareja" o "drenaje".'],
  maquillaje: ['un estudio de maquillaje', 'dicen "maquillaje social", "de novia", "de quinceañero" o "prueba de maquillaje".'],
  tattoo: ['un estudio de tatuajes', 'casi siempre necesitan una consulta o cotización primero: pregunta el tamaño y la zona del cuerpo y, si no hay un servicio de consulta en la lista, toma el mensaje.'],
  'pet-grooming': ['un grooming de mascotas', 'dicen "baño", "corte", "deslanado"; pregunta la raza y el tamaño de la mascota.'],
  bienestar: ['un centro de bienestar', 'dicen "clase", "sesión", "entrenamiento personal" o "evaluación".'],
  waxing: ['un estudio de waxing', 'dicen "cera", "brasileño", "bikini", "axilas" o "cejas".'],
};

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
const diez = (tel) => String(tel || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const bonito = (e164) => { const d = diez(e164); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : ''; };
// Texto que va al prompt o a la voz: una línea, sin {{ }} (no se cuelan variables de Retell)
const limpio = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F]+/g, ' ')
  .replace(/[{}]+/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
// Lo que dicta quien llama sale en un WhatsApp con la marca Bukéame: sin enlaces (anti-phishing)
const sinEnlaces = (s) => String(s || '')
  .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[enlace]')
  .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|info|biz|io|co|ly|me|app|link|xyz|site|online|shop|pr|us|gl|to|cc|tk)\b\S*/gi, '[enlace]');

// Voces que el dueño puede escoger: RETELL_VOCES="voice_id|Etiqueta,voice_id|Etiqueta"
function voces() {
  return String(process.env.RETELL_VOCES || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [id, label] = x.split('|');
    return { id: id.trim(), label: (label || id).trim() };
  }).filter((v) => /^[\w.-]{2,80}$/.test(v.id));
}

module.exports.mount = function (app, ctx) {
  const { db, authRequired, businessScope, h, port, interno } = ctx;
  const { asyncH, bad, isUuid, isDate, isStr, isPhone, normPhone, alertOwner, oneLine, audit } = h;
  const PUBLIC = `http://127.0.0.1:${port}/api/public`;
  const SITE = () => process.env.VOZ_BASE_URL || 'https://bukeame.com';
  const RETELL = () => process.env.RETELL_API_BASE || 'https://api.retellai.com';
  const listo = () => !!(process.env.RETELL_VOZ_KEY && process.env.RETELL_API_KEY && process.env.RETELL_AGENT_ID);
  const maxSimultaneas = () => Number(process.env.VOZ_MAX_SIMULTANEAS) || 3;

  const igual = (a, b) => {
    a = String(a || ''); b = String(b || '');
    return !!b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  };

  // ---------- Retell ----------
  async function retell(method, path, body, ms = 20_000) {
    const r = await fetch(RETELL() + path, {
      method,
      headers: { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(ms),
    });
    let data = null;
    try { data = await r.json(); } catch (_e) {}
    return { ok: r.ok, status: r.status, data: data || {} };
  }

  // Firma de Retell: "v=<ms>,d=<hex>" = HMAC-SHA256(cuerpo crudo + ms) con la API key; 5 min de ventana.
  let avisoFirma = 0;
  function firmaOk(req) {
    const key = process.env.RETELL_API_KEY;
    const m = /^v=(\d+),d=([0-9a-fA-F]+)$/.exec(String(req.get('x-retell-signature') || ''));
    let ok = false;
    if (key && m && req.rawBody && Math.abs(Date.now() - Number(m[1])) <= 5 * 60_000) {
      const esperado = crypto.createHmac('sha256', key).update(req.rawBody.toString('utf8') + m[1]).digest('hex');
      ok = igual(m[2].toLowerCase(), esperado);
    }
    if (!ok && Date.now() - avisoFirma > 10 * 60_000) {
      avisoFirma = Date.now();
      console.error(`voz: firma de Retell inválida en ${req.path}. ¿RETELL_API_KEY es la llave con la etiqueta "webhook"?`);
    }
    return ok;
  }
  const funcionOk = (req) => igual(req.get('x-bukeame-voz'), process.env.RETELL_VOZ_KEY);

  // ---------- Add-on, periodo y minutos ----------
  async function addonActivo(businessId) {
    try {
      const { rows } = await db.query(
        `SELECT 1 FROM addons WHERE business_id = $1 AND code = $2 AND status = 'active'
           AND (current_period_end IS NULL OR now() <= current_period_end + interval '7 days')`, [businessId, ADDON]);
      return !!rows[0];
    } catch (e) {
      if (e.code === '22P02') return false;   // sin la migración 35 el enum no tiene el código
      throw e;                                 // un error de la base NO es "no pagó"
    }
  }

  // Periodo de minutos = el bloque de 30 días pagado del add-on que contiene "ahora"
  // (renovar antes de tiempo no regala minutos; en la gracia sigue el mismo bloque).
  // Sin fecha de vencimiento (add-ons viejos), el mes calendario de PR.
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

  // Minutos del periodo. Las llamadas sin terminar de los últimos 15 min cuentan como
  // MAX_MIN_LLAMADA (así 10 llamadas a la vez no se saltan el tope).
  async function minutos(businessId, inicio) {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(duration_sec) FILTER (WHERE duration_sec IS NOT NULL), 0)::int AS s,
              COUNT(*) FILTER (WHERE duration_sec IS NULL AND ended_at IS NULL AND started_at > now() - interval '15 minutes')::int AS en_curso
         FROM voice_calls WHERE business_id = $1 AND started_at >= $2`, [businessId, inicio]);
    return { usados: Math.ceil(rows[0].s / 60), enCurso: rows[0].en_curso };
  }

  // De qué negocio es una llamada: SOLO la que registró el webhook de entrada (firmado).
  async function negocioDeLlamada(call) {
    const callId = call && typeof call.call_id === 'string' ? call.call_id : null;
    if (!callId) return null;
    const b = (await db.query(
      `SELECT b.id, b.slug, b.name, vl.mode, vl.phone_number, vc.limited
         FROM voice_calls vc
         JOIN businesses b ON b.id = vc.business_id AND b.deleted_at IS NULL
         JOIN voice_lines vl ON vl.business_id = b.id
        WHERE vc.call_id = $1`, [callId])).rows[0];
    if (!b || !b.phone_number || !(await addonActivo(b.id))) return null;
    return { ...b, callId, soloMensajes: b.limited || b.mode === 'messages' };
  }

  // Cupo por llamada (citas / mensajes): se toma ANTES de actuar y se devuelve si falla
  async function tomarCupo(callId, campo) {
    const r = await db.query(`UPDATE voice_calls SET ${campo} = ${campo} + 1 WHERE call_id = $1 AND ${campo} < ${POR_LLAMADA} RETURNING 1`, [callId]);
    return !!r.rows[0];
  }
  const soltarCupo = (callId, campo) => db.query(`UPDATE voice_calls SET ${campo} = GREATEST(${campo} - 1, 0) WHERE call_id = $1`, [callId]);

  async function marcar(callId, outcome, code) {
    // Una cita pesa más que un mensaje: no se pisa
    await db.query(
      `UPDATE voice_calls SET outcome = $2, appointment_code = COALESCE($3, appointment_code)
        WHERE call_id = $1 AND (outcome <> 'booked' OR $2 = 'booked')`, [callId, outcome, code || null]);
  }

  // Ruta pública de la web por loopback: misma validación que una reserva en línea.
  // X-Bukeame-Interno (secreto que server.js genera al arrancar) saca estos pedidos del
  // rate-limit compartido; los cupos por llamada de arriba lo reemplazan.
  async function pub(path, opts = {}) {
    const headers = { 'X-Bukeame-Interno': interno || '' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const r = await fetch(PUBLIC + path, {
      method: opts.method || 'GET', headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
    let data = {};
    try { data = await r.json(); } catch (_e) {}
    return { ok: r.ok, status: r.status, data };
  }

  // ==========================================================================
  //  1) WEBHOOK DE ENTRADA — Retell pregunta de quién es el número que sonó.
  //     Siempre 200: rechazar es inofensivo aunque el pedido sea falso, y un 4xx/5xx
  //     haría que Retell reintente.
  // ==========================================================================
  app.post('/api/voz/entrante', async (req, res) => {
    const rechazar = () => res.json({ call_inbound: { reject: true } });
    try {
      if (!listo() || !firmaOk(req)) return rechazar();
      const ci = (req.body && req.body.call_inbound) || {};
      if (typeof ci.to_number !== 'string' || typeof ci.call_id !== 'string') return rechazar();

      const L = (await db.query(
        `SELECT vl.*, b.id AS bid, b.name, m.name AS municipality
           FROM voice_lines vl JOIN businesses b ON b.id = vl.business_id
           LEFT JOIN pr_municipalities m ON m.id = b.municipality_id
          WHERE vl.phone_number = $1 AND b.deleted_at IS NULL`, [ci.to_number])).rows[0];
      if (!L || !(await addonActivo(L.bid))) return rechazar();
      if (L.line_status === 'paused') {
        await db.query(`UPDATE voice_lines SET line_status = 'active', paused_at = NULL WHERE business_id = $1`, [L.bid]);
      }

      const { inicio } = await periodo(L.bid);
      const { usados, enCurso } = await minutos(L.bid, inicio);
      const tope = L.minutes_included || 150;
      const comprometidos = usados + enCurso * MAX_MIN_LLAMADA;
      if (enCurso >= maxSimultaneas()) return rechazar();               // llamadas a la vez
      if (comprometidos >= Math.ceil(tope * 1.5)) return rechazar();    // tope duro del periodo
      const desde = String(ci.from_number || '').slice(0, 20);
      if (desde) {
        const rep = (await db.query(
          `SELECT count(*)::int n FROM voice_calls WHERE business_id = $1 AND from_number = $2 AND started_at > now() - interval '1 hour'`,
          [L.bid, desde])).rows[0].n;
        if (rep >= 6) return rechazar();                                 // mismo número llamando sin parar
      }
      const limitado = comprometidos >= tope;

      const [cats, staff, svcs] = await Promise.all([
        db.query(`SELECT c.slug FROM business_categories bc JOIN categories c ON c.id = bc.category_id WHERE bc.business_id = $1`, [L.bid]),
        db.query(`SELECT display_name FROM staff WHERE business_id = $1 AND is_active AND deleted_at IS NULL ORDER BY sort_order`, [L.bid]),
        db.query(`SELECT name FROM services WHERE business_id = $1 AND is_active AND deleted_at IS NULL`, [L.bid]),
      ]);
      const tipo = cats.rows.map((c) => TIPOS[c.slug]).find(Boolean);
      const faq = (Array.isArray(L.faq) ? L.faq : []).slice(0, MAX_FAQ)
        .map((x) => `P: ${limpio(x.q, 140)} R: ${limpio(x.a, 400)}`).join('\n');

      await db.query(
        `INSERT INTO voice_calls (call_id, business_id, from_number, to_number, limited)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (call_id) DO NOTHING`,
        [ci.call_id.slice(0, 100), L.bid, desde, ci.to_number, limitado]);

      const saludo = limpio(L.greeting, 160) || `Gracias por llamar a ${limpio(L.name, 80)}.`;
      const vars = {
        negocio_nombre: limpio(L.name, 80),
        negocio_tipo: tipo ? tipo[0] : 'un negocio',
        negocio_pueblo: limpio(L.municipality, 60) || 'Puerto Rico',
        vocabulario: tipo ? `Sus clientes ${tipo[1]}` : 'No hay.',
        apodos: limpio(L.aliases, 600) || 'No hay.',
        preguntas_frecuentes: faq || 'No hay.',
        aviso_limite: limitado ? 'IMPORTANTE: ya se usaron los minutos del plan. Sé breve: toma el mensaje y despídete.' : '',
        modo: (limitado || L.mode === 'messages') ? 'solo_mensajes' : 'reservar',
        puede_transferir: L.transfer_number ? 'sí' : 'no',
        transfer_number: L.transfer_number || '',
        saludo_inicial: `${saludo} ${AVISO}`,
      };
      const out = { override_agent_id: process.env.RETELL_AGENT_ID, dynamic_variables: vars, metadata: { business_id: L.bid } };
      // Ajustes del agente para esta llamada. Si Retell los rechazara, VOZ_OVERRIDE=0 los apaga.
      if (process.env.VOZ_OVERRIDE !== '0') {
        const palabras = [L.name, ...staff.rows.map((s) => s.display_name), ...svcs.rows.map((s) => s.name)]
          .map((w) => limpio(w, 40).replace(/["“”]/g, '')).filter(Boolean);
        const agent = { max_call_duration_ms: (limitado ? 2 : MAX_MIN_LLAMADA) * 60_000 };
        if (L.voice_id && voces().some((v) => v.id === L.voice_id)) agent.voice_id = L.voice_id;
        if (palabras.length) agent.boosted_keywords = [...new Set(['Bukéame', ...palabras])].slice(0, 25);
        out.agent_override = { agent };
      }
      return res.json({ call_inbound: out });
    } catch (e) {
      console.error('voz entrante:', e.message);
      return rechazar();
    }
  });

  // ==========================================================================
  //  2) FUNCIONES DURANTE LA LLAMADA
  // ==========================================================================
  app.post('/api/voz/fn/:fn', asyncH(async (req, res) => {
    if (!process.env.RETELL_VOZ_KEY) return res.status(503).json({ error: 'La recepcionista IA no está activada.' });
    if (!funcionOk(req)) return res.status(401).json({ error: 'No autorizado.' });
    const body = req.body || {};
    const args = body.args && typeof body.args === 'object' ? body.args : {};
    const N = await negocioDeLlamada(body.call);
    if (!N) return res.json({ error: 'No pude identificar el negocio de esta llamada. Discúlpate y dile al cliente que llame más tarde o que reserve en Bukéame.' });
    const slug = encodeURIComponent(N.slug);

    switch (req.params.fn) {
      // --- servicios, equipo, horario y reglas del negocio ---
      case 'info_negocio': {
        const r = await pub(`/${slug}`);
        if (!r.ok) return res.json({ error: 'No pude ver la información del negocio ahora mismo.' });
        const { business: b, services = [], staff = [], hours = [] } = r.data;
        const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
        const hora12 = (t) => { const [hh, mm] = String(t).split(':').map(Number); return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`; };
        return res.json({
          negocio: b.name,
          direccion: oneLine([b.address_line, b.municipality].filter(Boolean).join(', ')),
          modo: N.soloMensajes ? 'solo_mensajes' : 'reservar',
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
          equipo: staff.map((s) => ({ id: s.id, nombre: s.display_name })),
        });
      }

      // --- horas libres de un día (pocas y en hora de PR: la IA las dice en voz alta) ---
      case 'buscar_horas': {
        const { service_id, fecha, staff_id, hora_preferida, parte_del_dia } = args;
        if (!isUuid(service_id)) return res.json({ error: 'Falta el servicio (usa el id de info_negocio).' });
        if (!isDate(fecha)) return res.json({ error: 'La fecha debe venir como AAAA-MM-DD.' });
        let q = `/${slug}/availability?service_id=${service_id}&date=${fecha}`;
        if (isUuid(staff_id)) q += `&staff_id=${staff_id}`;
        const r = await pub(q);
        if (!r.ok) return res.json({ error: r.data.error || 'No pude ver las horas ahora mismo.' });
        const todas = (r.data.slots || []).filter((s) => String(s).includes('T'));
        let slots = todas;
        if (!todas.length) {
          return res.json({ fecha, horas: [], mensaje: r.data.reason === 'fuera_de_horizonte'
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
          return res.json({ fecha: fechaPR(todas[0]), horas: [],
            mensaje: `A esa hora o en esa parte del día no queda nada, pero ese día hay ${todas.length} horas en otro momento. Pregunta si le sirve otra hora.` });
        }
        return res.json({
          fecha: fechaPR(pocas[0]),
          horas: pocas.map((s) => ({ hora: horaPR(s), start_iso: s })),
          quedan_mas: Math.max(0, todas.length - pocas.length),
          nota: 'Para reservar usa el start_iso exacto de la hora que escoja el cliente.',
        });
      }

      // --- reservar (misma ruta pública: valida el turno, cobra depósito si aplica y manda el WhatsApp) ---
      case 'reservar_cita': {
        if (N.soloMensajes) return res.json({ ok: false, error: 'En esta llamada no puedo hacer citas. Toma el mensaje con dejar_mensaje y dile que el negocio lo llama para darle el turno.' });
        const { service_id, start_iso, nombre, telefono, staff_id, nota } = args;
        if (!isUuid(service_id) || !isStr(start_iso, 40)) return res.json({ ok: false, error: 'Faltan el servicio o la hora.' });
        if (!isStr(nombre, 120)) return res.json({ ok: false, error: 'Falta el nombre del cliente.' });
        const tel = diez(telefono);
        if (!isPhone(tel)) return res.json({ ok: false, error: 'El teléfono debe tener 10 dígitos.' });
        if (!(await tomarCupo(N.callId, 'bookings'))) {
          return res.json({ ok: false, error: `En una llamada se pueden hacer hasta ${POR_LLAMADA} citas. Para más, que reserve en Bukéame o toma el mensaje.` });
        }
        const payload = { service_id, start_iso, full_name: nombre.trim(), phone: tel,
          client_notes: (isStr(nota, 300) ? nota.trim() + ' · ' : '') + 'Reservada por teléfono (recepcionista IA)' };
        if (isUuid(staff_id)) payload.staff_id = staff_id;
        let r;
        try { r = await pub(`/${slug}/appointments`, { method: 'POST', body: payload }); }
        catch (e) { await soltarCupo(N.callId, 'bookings'); throw e; }
        if (!r.ok) {
          await soltarCupo(N.callId, 'bookings');
          return res.json({ ok: false, error: r.data.error || 'No se pudo reservar. Ofrece otra hora.' });
        }
        const a = r.data.appointment || {};
        await marcar(N.callId, 'booked', a.confirmation_code);
        const pendiente = a.status === 'pending_deposit';
        return res.json({
          ok: true,
          codigo: a.confirmation_code,
          servicio: a.service_name,
          cuando: `${fechaPR(a.starts_at)} a las ${horaPR(a.starts_at)}`,
          con: a.staff_name || null,
          decir_al_cliente: pendiente
            ? `Quedó reservada, pendiente del depósito de ${dinero(a.deposit_cents)}. Le llega un WhatsApp con el enlace para pagarlo; tiene 30 minutos o el turno se libera.`
            : 'Quedó confirmada. Le llega un WhatsApp con la confirmación y el enlace de su cita.',
        });
      }

      // --- mensaje al dueño (lo que la IA no puede resolver): in-app + WhatsApp/email ---
      case 'dejar_mensaje': {
        const { nombre, telefono, mensaje } = args;
        if (!isStr(mensaje, 600)) return res.json({ error: 'Falta el mensaje.' });
        if (!(await tomarCupo(N.callId, 'messages'))) {
          return res.json({ ok: true, decir_al_cliente: 'Ya le dejé tu mensaje al negocio. Te van a contactar.' });
        }
        let tel = diez(telefono);
        if (tel.length !== 10) tel = diez(body.call && body.call.from_number);
        const quien = sinEnlaces(oneLine(isStr(nombre, 120) ? nombre : 'Un cliente')).slice(0, 80) + (tel.length === 10 ? ` (${normPhone(tel)})` : '');
        const detalle = oneLine(`${quien}: ${sinEnlaces(mensaje)}`).slice(0, 400);
        await alertOwner(N.id, null, {
          type: 'system', title: 'Mensaje de la recepcionista IA', body: detalle, template: 'owner_voice_msg',
          wa: `*Bukéame* — Mensaje de una llamada\n\n${detalle}\n\n(Lo tomó la recepcionista IA. Llama o escribe al cliente.)`,
        });
        await marcar(N.callId, 'message');
        return res.json({ ok: true, decir_al_cliente: 'Listo, le dejé el mensaje al negocio. Te van a contactar.' });
      }

      default:
        return res.status(404).json({ error: 'Función desconocida.' });
    }
  }));

  // ==========================================================================
  //  3) EVENTOS DE LA LLAMADA — duración, costo, resumen, grabación
  // ==========================================================================
  const ms = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

  async function guardarFin(call, conResumen) {
    const dur = ms(call.duration_ms) ? Math.round(ms(call.duration_ms) / 1000)
      : (ms(call.start_timestamp) && ms(call.end_timestamp) ? Math.round((call.end_timestamp - call.start_timestamp) / 1000) : null);
    const cost = call.call_cost && Number.isFinite(Number(call.call_cost.combined_cost)) ? Number(call.call_cost.combined_cost) : null;
    const an = (conResumen && call.call_analysis) || {};
    const resumen = (an.custom_analysis_data && typeof an.custom_analysis_data.resumen === 'string' && an.custom_analysis_data.resumen)
      || (typeof an.call_summary === 'string' && an.call_summary) || null;
    const motivo = typeof call.disconnection_reason === 'string' ? call.disconnection_reason.slice(0, 60) : null;
    await db.query(
      `UPDATE voice_calls
          SET ended_at = COALESCE(to_timestamp($2::float8 / 1000), ended_at, now()),
              duration_sec = COALESCE($3::int, duration_sec),
              cost_cents = COALESCE($4::numeric, cost_cents),
              recording_url = COALESCE($5, recording_url),
              disconnection_reason = COALESCE($6, disconnection_reason),
              summary = COALESCE($7, summary),
              outcome = CASE WHEN outcome = 'none' AND $6 IN ('call_transfer','transfer_bridged') THEN 'transferred' ELSE outcome END
        WHERE call_id = $1`,
      [call.call_id, ms(call.end_timestamp), dur, cost,
        typeof call.recording_url === 'string' ? call.recording_url.slice(0, 1000) : null, motivo,
        resumen ? oneLine(resumen).slice(0, 600) : null]);
  }

  app.post('/api/voz/eventos', asyncH(async (req, res) => {
    if (!process.env.RETELL_API_KEY) return res.status(503).end();
    if (!firmaOk(req)) return res.status(401).end();
    const { event, call } = req.body || {};
    if (!call || typeof call.call_id !== 'string') return res.status(204).end();
    // Solo llamadas que aceptó el webhook de entrada (las demás no son de ningún negocio)
    const fila = (await db.query(`SELECT business_id FROM voice_calls WHERE call_id = $1`, [call.call_id])).rows[0];
    if (!fila) return res.status(204).end();
    if (event === 'call_started' && ms(call.start_timestamp)) {
      await db.query(`UPDATE voice_calls SET started_at = to_timestamp($2::float8 / 1000) WHERE call_id = $1`, [call.call_id, ms(call.start_timestamp)]);
    }
    if (event === 'call_ended' || event === 'call_analyzed') {
      await guardarFin(call, event === 'call_analyzed');
      if (event === 'call_ended') await avisarMinutos(fila.business_id).catch((e) => console.error('voz minutos:', e.message));
    }
    res.status(204).end();
  }));

  // Aviso al dueño al 80 % y al 100 % de los minutos del periodo (una vez cada uno)
  async function avisarMinutos(businessId) {
    const L = (await db.query(`SELECT minutes_included, warned FROM voice_lines WHERE business_id = $1`, [businessId])).rows[0];
    if (!L) return;
    const tope = L.minutes_included || 150;
    const { inicio } = await periodo(businessId);
    const { usados } = await minutos(businessId, inicio);
    const clave = inicio.toISOString().slice(0, 10);
    let nivel = null;
    if (usados >= tope && L.warned !== `${clave}:100`) nivel = 100;
    else if (usados >= tope * 0.8 && !String(L.warned || '').startsWith(`${clave}:`)) nivel = 80;
    if (!nivel) return;
    await db.query(`UPDATE voice_lines SET warned = $2 WHERE business_id = $1`, [businessId, `${clave}:${nivel}`]);
    const txt = nivel === 100
      ? `Se usaron los ${tope} minutos de la recepcionista IA de este periodo. Hasta que se renueve el add-on, solo toma mensajes.`
      : `Llevas ${usados} de ${tope} minutos de la recepcionista IA en este periodo.`;
    await alertOwner(businessId, null, {
      type: 'system', title: 'Minutos de la recepcionista IA', body: txt, template: 'owner_voice_minutes',
      wa: `*Bukéame* — Recepcionista IA\n\n${txt}`,
    });
  }

  // ==========================================================================
  //  4) PANEL DEL NEGOCIO
  // ==========================================================================
  const PANEL = [authRequired, businessScope];
  let cacheVoces = { t: 0, list: [] };
  async function vocesParaPanel() {
    const vs = voces();
    if (!vs.length) return [];
    if (process.env.RETELL_API_KEY && Date.now() - cacheVoces.t > 12 * 3600_000) {
      try {
        const r = await retell('GET', '/list-voices', null, 5_000);
        if (r.ok && Array.isArray(r.data)) cacheVoces = { t: Date.now(), list: r.data };
        else cacheVoces.t = Date.now() - 12 * 3600_000 + 10 * 60_000;   // reintenta en 10 min
      } catch (_e) { cacheVoces.t = Date.now() - 12 * 3600_000 + 10 * 60_000; }
    }
    return vs.map((v) => {
      const info = cacheVoces.list.find((x) => x.voice_id === v.id) || {};
      return { id: v.id, label: v.label, preview: typeof info.preview_audio_url === 'string' ? info.preview_audio_url : null };
    });
  }

  app.get('/api/voice', ...PANEL, asyncH(async (req, res) => {
    const bizId = req.business.id;
    const [activo, cat, linea, per, vs] = await Promise.all([
      addonActivo(bizId),
      db.query(`SELECT price_cents FROM addon_catalog WHERE code::text = $1`, [ADDON]).catch(() => ({ rows: [] })),
      db.query(`SELECT * FROM voice_lines WHERE business_id = $1`, [bizId]),
      periodo(bizId),
      vocesParaPanel(),
    ]);
    const L = linea.rows[0] || {};
    let status = L.line_status || 'none';
    if (activo && status === 'paused' && L.phone_number) {       // renovó: vuelve a contestar ya
      await db.query(`UPDATE voice_lines SET line_status = 'active', paused_at = NULL WHERE business_id = $1`, [bizId]);
      status = 'active';
    }
    const { usados } = await minutos(bizId, per.inicio);
    res.json({
      addon_active: activo,
      price_cents: cat.rows[0] ? cat.rows[0].price_cents : 3900,
      ready: listo(),
      line: {
        phone_number: L.phone_number || null, pretty: bonito(L.phone_number), status,
        release_at: status === 'paused' && L.paused_at ? new Date(new Date(L.paused_at).getTime() + 30 * 864e5).toISOString() : null,
      },
      settings: {
        voice_id: L.voice_id || '', greeting: L.greeting || '', default_greeting: `Gracias por llamar a ${req.business.name}.`,
        disclosure: AVISO, faq: Array.isArray(L.faq) ? L.faq : [], aliases: L.aliases || '', mode: L.mode || 'book',
        transfer_number: L.transfer_number ? diez(L.transfer_number) : '',
      },
      voices: vs,
      usage: { minutes_used: usados, minutes_included: L.minutes_included || 150, period_end: per.fin.toISOString() },
    });
  }));

  app.put('/api/voice', ...PANEL, asyncH(async (req, res) => {
    const b = req.body || {};
    const voice_id = b.voice_id ? String(b.voice_id) : null;
    if (voice_id && !voces().some((v) => v.id === voice_id)) return bad(res, 'Esa voz no está disponible.');
    const greeting = limpio(b.greeting, 160) || null;
    const mode = b.mode === 'messages' ? 'messages' : 'book';
    let transfer = null;
    if (b.transfer_number) {
      const d = diez(b.transfer_number);
      if (!isPhone(d)) return bad(res, 'El número para pasar llamadas debe tener 10 dígitos.');
      if (AREAS_BLOQUEADAS.has(d.slice(0, 3))) return bad(res, 'Ese número no se puede usar para pasar llamadas. Usa un número de Puerto Rico o de Estados Unidos.');
      const propios = [req.business.phone, req.business.whatsapp].map((x) => diez(x).slice(-10));
      if (propios.includes(d)) return bad(res, 'Ese es el teléfono del negocio, que es el que le pasa las llamadas a la recepcionista: la llamada daría vueltas. Usa otro número.');
      transfer = `+1${d}`;
    }
    const aliases = limpio(String(b.aliases || '').replace(/\n+/g, '; '), 600) || null;
    const faq = (Array.isArray(b.faq) ? b.faq : [])
      .map((x) => ({ q: limpio(x && x.q, 140), a: limpio(x && x.a, 400) })).filter((x) => x.q && x.a);
    if (faq.length > MAX_FAQ) return bad(res, `Puedes poner hasta ${MAX_FAQ} preguntas.`);
    await db.query(
      `INSERT INTO voice_lines (business_id, voice_id, greeting, faq, aliases, mode, transfer_number)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
       ON CONFLICT (business_id) DO UPDATE
          SET voice_id = EXCLUDED.voice_id, greeting = EXCLUDED.greeting, faq = EXCLUDED.faq,
              aliases = EXCLUDED.aliases, mode = EXCLUDED.mode, transfer_number = EXCLUDED.transfer_number,
              updated_at = now()`,
      [req.business.id, voice_id, greeting, JSON.stringify(faq), aliases, mode, transfer]);
    await audit(req, 'voice.settings', 'business', req.business.id, { mode, faq: faq.length, transfer: !!transfer });
    res.json({ ok: true });
  }));

  // Compra el número de Retell del negocio. Antes de comprar busca uno que ya tenga su
  // apodo (si una compra anterior se cortó, se adopta en vez de pagar otro). Solo prueba
  // el siguiente código de área si Retell dice que no hay números (4xx de inventario).
  async function comprarNumero(bizId) {
    const apodo = `bukeame-${bizId}`;
    const lista = await retell('GET', '/list-phone-numbers', null, 15_000);
    if (!lista.ok || !Array.isArray(lista.data)) throw new Error(`no pude ver los números de Retell (${lista.status})`);
    const ya = lista.data.find((n) => n && n.nickname === apodo && /^\+1\d{10}$/.test(String(n.phone_number || '')));
    if (ya) return ya.phone_number;

    const base = { inbound_webhook_url: `${SITE()}/api/voz/entrante`, nickname: apodo };
    // Sin agente fijo: si el webhook no contesta, Retell cuelga en vez de conectar (no cobra).
    if (process.env.VOZ_AGENTE_EN_NUMERO === '1') base.inbound_agents = [{ agent_id: process.env.RETELL_AGENT_ID, weight: 1 }];
    const areas = String(process.env.VOZ_AREAS || '787,939').split(',').map((x) => Number(x.trim())).filter((n) => n >= 200 && n <= 999);
    for (const area_code of [...areas, null]) {      // 787, 939 y, si no hay, cualquiera de EE. UU.
      const r = await retell('POST', '/create-phone-number', area_code ? { ...base, area_code } : base, 30_000);
      if (r.ok) {
        if (/^\+1\d{10}$/.test(String(r.data.phone_number || ''))) return r.data.phone_number;
        throw new Error(`Retell compró algo raro: ${JSON.stringify(r.data).slice(0, 200)}`);   // no seguir comprando
      }
      if (![400, 404, 409, 422].includes(r.status)) throw new Error(`Retell ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
    }
    throw new Error('Retell no tiene números disponibles');
  }

  app.post('/api/voice/line', ...PANEL, asyncH(async (req, res) => {
    const bizId = req.business.id;
    if (!listo()) return bad(res, 'La recepcionista IA todavía no está disponible. Te avisamos cuando esté lista.', 503);
    if (!(await addonActivo(bizId))) return bad(res, 'Primero activa el add-on Recepcionista IA en Mi cuenta.', 402);
    await db.query(`INSERT INTO voice_lines (business_id) VALUES ($1) ON CONFLICT (business_id) DO NOTHING`, [bizId]);
    const lock = await db.query(
      `UPDATE voice_lines SET line_status = 'buying', updated_at = now()
        WHERE business_id = $1 AND phone_number IS NULL
          AND (line_status = 'none' OR (line_status = 'buying' AND updated_at < now() - interval '3 minutes'))
        RETURNING business_id`, [bizId]);
    if (!lock.rows[0]) {
      const cur = (await db.query(`SELECT phone_number FROM voice_lines WHERE business_id = $1`, [bizId])).rows[0];
      if (cur && cur.phone_number) {
        await db.query(`UPDATE voice_lines SET line_status = 'active', paused_at = NULL WHERE business_id = $1`, [bizId]);
        return res.json({ ok: true, phone_number: cur.phone_number, pretty: bonito(cur.phone_number) });
      }
      return bad(res, 'Ya estamos activando tu línea. Espera unos segundos.', 409);
    }
    try {
      const num = await comprarNumero(bizId);
      await db.query(
        `UPDATE voice_lines SET phone_number = $2, line_status = 'active', paused_at = NULL, updated_at = now() WHERE business_id = $1`,
        [bizId, num]);
      await audit(req, 'voice.line', 'business', bizId, { phone_number: num });
      res.json({ ok: true, phone_number: num, pretty: bonito(num) });
    } catch (e) {
      await db.query(`UPDATE voice_lines SET line_status = 'none', updated_at = now() WHERE business_id = $1 AND line_status = 'buying'`, [bizId]);
      console.error('voz: no se pudo comprar el número:', e.message);
      bad(res, 'No pudimos activar la línea ahora mismo. Intenta en unos minutos.', 502);
    }
  }));

  app.get('/api/voice/calls', ...PANEL, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `SELECT call_id, from_number, started_at, duration_sec, outcome, appointment_code, summary, limited,
              (recording_url IS NOT NULL) AS has_recording
         FROM voice_calls WHERE business_id = $1 ORDER BY started_at DESC LIMIT 50`, [req.business.id]);
    res.json({ calls: rows });
  }));

  // La grabación se pide fresca a Retell (los enlaces firmados vencen); si no, la guardada.
  app.get('/api/voice/calls/:id/recording', ...PANEL, asyncH(async (req, res) => {
    if (!/^[\w-]{4,100}$/.test(req.params.id)) return bad(res, 'Llamada inválida.');
    const row = (await db.query(`SELECT recording_url FROM voice_calls WHERE call_id = $1 AND business_id = $2`,
      [req.params.id, req.business.id])).rows[0];
    if (!row) return bad(res, 'Llamada no encontrada.', 404);
    let url = row.recording_url;
    if (process.env.RETELL_API_KEY) {
      try {
        const r = await retell('GET', `/v2/get-call/${encodeURIComponent(req.params.id)}`, null, 8_000);
        if (r.ok && typeof r.data.recording_url === 'string') url = r.data.recording_url;
      } catch (_e) {}
    }
    if (!url) return bad(res, 'Esta llamada no tiene grabación.', 404);
    res.json({ url });
  }));

  // ==========================================================================
  //  5) REVISOR (cada 30 min): llamadas sin cerrar y líneas sin add-on
  // ==========================================================================
  async function revisarLineas() {
    if (!process.env.RETELL_VOZ_KEY) return;

    // a) Llamadas que nunca recibieron su evento final: se le pregunta a Retell, para que
    //    los minutos cuadren aunque un webhook se pierda.
    if (process.env.RETELL_API_KEY) {
      const abiertas = (await db.query(
        `SELECT call_id FROM voice_calls
          WHERE duration_sec IS NULL AND started_at < now() - interval '20 minutes' AND started_at > now() - interval '3 days'
          ORDER BY started_at LIMIT 50`)).rows;
      for (const c of abiertas) {
        try {
          const r = await retell('GET', `/v2/get-call/${encodeURIComponent(c.call_id)}`, null, 10_000);
          if (r.ok && (ms(r.data.duration_ms) || ['ended', 'not_connected', 'error'].includes(r.data.call_status))) {
            await guardarFin({ ...r.data, call_id: c.call_id, duration_ms: r.data.duration_ms || 0 }, true);
            if (!ms(r.data.duration_ms)) await db.query(`UPDATE voice_calls SET duration_sec = 0 WHERE call_id = $1 AND duration_sec IS NULL`, [c.call_id]);
          } else if (r.status === 404) {
            await db.query(`UPDATE voice_calls SET duration_sec = 0, ended_at = COALESCE(ended_at, now()) WHERE call_id = $1`, [c.call_id]);
          }
        } catch (e) { console.error('voz conciliar:', c.call_id, e.message); }
      }
    }

    // b) Líneas: pausa al vencer, se reactiva al renovar, se suelta a los 30 días en pausa
    const { rows } = await db.query(
      `SELECT business_id, phone_number, line_status, paused_at FROM voice_lines WHERE phone_number IS NOT NULL`);
    for (const L of rows) {
      try {
        const activo = await addonActivo(L.business_id);
        if (activo && L.line_status === 'paused') {
          await db.query(`UPDATE voice_lines SET line_status = 'active', paused_at = NULL WHERE business_id = $1`, [L.business_id]);
        } else if (!activo && L.line_status === 'active') {
          await db.query(`UPDATE voice_lines SET line_status = 'paused', paused_at = now() WHERE business_id = $1`, [L.business_id]);
          const txt = `Tu recepcionista IA está en pausa porque venció el add-on. Guardamos tu número ${bonito(L.phone_number)} por 30 días: renuévalo en Mi cuenta para que vuelva a contestar. Mientras tanto, quita el desvío de llamadas (marca ##002#).`;
          await alertOwner(L.business_id, null, { type: 'system', title: 'Recepcionista IA en pausa', body: txt,
            template: 'owner_voice_paused', wa: `*Bukéame* — Recepcionista IA\n\n${txt}` }).catch(() => {});
        } else if (!activo && L.line_status === 'paused' && L.paused_at && Date.now() - new Date(L.paused_at) > 30 * 864e5) {
          if (!process.env.RETELL_API_KEY) continue;
          const r = await retell('DELETE', `/delete-phone-number/${encodeURIComponent(L.phone_number)}`);
          if (r.ok || r.status === 404) {
            await db.query(`UPDATE voice_lines SET phone_number = NULL, line_status = 'none', paused_at = NULL WHERE business_id = $1`, [L.business_id]);
            console.log(`voz: se soltó el número ${L.phone_number} (add-on vencido hace 30 días)`);
          } else {
            console.error(`voz: no se pudo soltar ${L.phone_number}: ${r.status}`);
          }
        }
      } catch (e) { console.error('voz línea:', L.business_id, e.message); }
    }
  }

  console.log('  ✓ módulo voz montado (recepcionista IA por teléfono)');
  return { revisarLineas };
};
