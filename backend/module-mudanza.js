// ============================================================================
//  Mudanza a Bukéame: pasar lo que el negocio tenía en otra plataforma (Booksy,
//  Fresha, GOLDIE, Square, Vagaro…) o en su libreta: servicios, clientes, citas
//  futuras, visitas y ventas de antes, tarjetas de regalo, paquetes y puntos.
// ----------------------------------------------------------------------------
//  · El archivo se lee en el equipo del negocio (mudanza.html); aquí llegan las filas.
//  · Primero se arma un resumen (qué pasa, qué ya estaba y qué se queda fuera, con su
//    porqué). Nada se guarda hasta que el negocio confirma, y se deshace por 7 días.
//  · Claude solo ayuda a reconocer columnas (ve los encabezados y la forma de unas filas,
//    sin datos de clientes) y a leer la foto de una lista de precios. Los datos los
//    copia el código tal cual: la IA no puede inventar un precio ni un cliente.
//  · Las visitas de antes van a client_import_history, no a citas: no suben la lealtad,
//    no disparan el "te toca" y no cuentan para las difusiones (esas piden su propio sí).
//  · Las ventas de antes van a imported_sales, aparte de la contabilidad de Bukéame.
// ============================================================================
const crypto = require('crypto');
const express = require('express');
const L = require('./mudanza-lector');

const PLATAFORMAS = {
  booksy: 'Booksy', fresha: 'Fresha', goldie: 'GOLDIE', square: 'Square', vagaro: 'Vagaro',
  otra: 'otra plataforma', ninguna: 'sin plataforma',
};
const MAX_ARCHIVOS = 12;
const MAX_FILAS = 20000;          // por archivo; uno más grande se baja por partes (por fechas)
const MAX_COLUMNAS = 80;
const MAX_CELDA = 500;
const MAX_ARCHIVOS_BORRADOR = 24; // contando los que el negocio quitó
const MAX_FILAS_BORRADOR = 60000;
const MAX_CITAS = 3000;           // citas que vienen, por mudanza
const RECORDATORIOS_DIA = 60;     // citas mudadas con recordatorio por día: el WhatsApp es compartido
const DESHACER_DIAS = 7;
const IA_POR_DIA = 40;            // llamadas a Claude por negocio al día (columnas + fotos)
const ALIVE = ['pending_deposit', 'confirmed'];
const tiene = (obj, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(obj, k);
// Un enlace en el nombre de un servicio saldría en los recordatorios del WhatsApp compartido.
const ENLACE = /(https?:|www[.．。]|xn--|\b\d{1,3}(?:[.．。]\d{1,3}){3}\b|[\p{L}\p{N}_-][.．。]\p{L}{2,})/iu;
const ALFA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // sin O/0/I/1/L

const CAMPOS_IA = [...new Set(Object.values(L.TIPOS).flatMap((t) => Object.keys(t.campos)))];
const ESQUEMA_COLUMNAS = {
  type: 'object',
  properties: {
    tipo: { type: 'string', enum: [...L.ORDEN_TIPOS, 'otro'] },
    columnas: {
      type: 'object',
      properties: Object.fromEntries(CAMPOS_IA.map((c) => [c, { type: 'string' }])),
      required: CAMPOS_IA,
      additionalProperties: false,
    },
  },
  required: ['tipo', 'columnas'],
  additionalProperties: false,
};
const ESQUEMA_FOTO = {
  type: 'object',
  properties: {
    legible: { type: 'boolean' },
    servicios: {
      type: 'array',
      items: {
        type: 'object',
        properties: { nombre: { type: 'string' }, precio: { type: 'string' }, minutos: { type: 'string' } },
        required: ['nombre', 'precio', 'minutos'],
        additionalProperties: false,
      },
    },
  },
  required: ['legible', 'servicios'],
  additionalProperties: false,
};

const CAMPOS_TXT = Object.entries(L.TIPOS).map(([k, t]) =>
  `${k}: ${Object.entries(t.campos).map(([c, f]) => `${c} (${f.e})`).join(', ')}`).join('\n');
const SISTEMA_COLUMNAS = `Ayudas a mudar un negocio de citas (barbería, salón, spa, uñas…) de otra plataforma a Bukéame.
Recibes los encabezados de UN archivo que el negocio exportó y la forma de unas filas: las letras salen como X/x y los números como 9, así que no ves datos reales.
Di qué tipo de archivo es y qué encabezado corresponde a cada campo.

Tipos: clientes (lista de clientes), servicios (el menú con precio y duración), citas (citas pasadas o futuras), ventas (cobros o transacciones), tarjetas (tarjetas de regalo con saldo), paquetes (paquetes o membresías prepagadas con visitas que le quedan al cliente), lealtad (puntos o sellos por cliente), otro (ninguno de esos).

Campos de cada tipo:
${CAMPOS_TXT}

Reglas:
- Escribe el encabezado exactamente como aparece. Si ningún encabezado corresponde a un campo, o el campo no es de ese tipo, pon "".
- No uses el mismo encabezado para dos campos.
- Si dudas, pon "". Es mejor dejar un campo vacío que ponerle la columna equivocada.`;

const SISTEMA_FOTO = `Lees la foto de la lista de precios de un negocio (barbería, salón, spa, uñas…) para pasar sus servicios a Bukéame.
Copia cada servicio tal como aparece: el nombre, el precio y la duración si la foto la dice.
- No inventes servicios, precios ni duraciones. Si algo no se lee o no está en la foto, déjalo en "".
- El precio va como aparece ("$25", "desde $40"). La duración también ("45 min", "1 h").
- Si la foto no es una lista de servicios o no se puede leer, legible=false y servicios vacío.`;

let claudeCliente;   // undefined = sin probar · null = no disponible
function claude() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (claudeCliente === undefined) {
    try { const Anthropic = require('@anthropic-ai/sdk'); claudeCliente = new Anthropic(); }
    catch (e) { console.error('mudanza: falta @anthropic-ai/sdk (corre npm install en backend):', e.message); claudeCliente = null; }
  }
  return claudeCliente;
}
async function preguntarClaude(sistema, contenido, esquema) {
  const ia = claude();
  if (!ia) return null;
  const model = process.env.MUDANZA_MODELO || 'claude-opus-5-5';
  const r = await ia.beta.messages.create({
    model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: esquema } },
    system: sistema,
    messages: [{ role: 'user', content: contenido }],
  });
  if (r.stop_reason === 'refusal' || r.stop_reason === 'max_tokens') throw new Error('la IA no terminó: ' + r.stop_reason);
  return JSON.parse((r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
}

const dinero = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(Number(c || 0)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fechaPR = (d, conHora) => new Date(d).toLocaleString('es-PR', {
  timeZone: 'America/Puerto_Rico', day: 'numeric', month: 'short', year: 'numeric',
  ...(conHora ? { hour: 'numeric', minute: '2-digit' } : {}),
});
const telBonito = (p) => (p && p.length === 12 ? `(${p.slice(2, 5)}) ${p.slice(5, 8)}-${p.slice(8)}` : p || '');
const nombreClave = (s) => L.clave(s || '');

module.exports.mount = function (app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, isUuid, isEmail, normPhone, audit, confirmCode } = h;
  const PANEL = [authRequired, businessScope];
  // El cuerpo se lee aquí, después de revisar la sesión (server.js no lo lee para /api/mudanza):
  // así nadie sin cuenta puede hacer que el servidor procese 25 MB.
  const cuerpoGrande = express.json({ limit: '25mb' });
  const cuerpo = express.json({ limit: '100kb' });
  const adminRequired = (req, res, next) => (req.user && req.user.is_platform_admin ? next() : bad(res, 'Acceso restringido al administrador', 403));

  // ---------- Topes por negocio (en memoria: son un freno, no contabilidad) ----------
  //  · IA: 40 llamadas al día (columnas + fotos), porque cuestan.
  //  · Análisis: 60 por hora, porque cada uno puede traer miles de filas.
  const usos = new Map();
  function gastar(clave, tope) {
    const n = usos.get(clave) || 0;
    if (n >= tope) return false;
    usos.set(clave, n + 1);
    if (usos.size > 5000) for (const key of [...usos.keys()].slice(0, 2500)) usos.delete(key);
    return true;
  }
  const gastarIA = (bid) => gastar(`ia:${bid}:${new Date().toISOString().slice(0, 10)}`, IA_POR_DIA);
  const gastarAnalisis = (bid) => gastar(`an:${bid}:${new Date().toISOString().slice(0, 13)}`, 60);
  const limiteAnalisis = (req, res, next) => (gastarAnalisis(req.business.id) ? next() : bad(res, 'Llevas muchos análisis en esta hora. Espera un rato y sigue.', 429));

  // ---------- Lo que llega del navegador ----------
  function leerArchivos(lista) {
    if (!Array.isArray(lista) || !lista.length) throw Object.assign(new Error('Sube al menos un archivo.'), { status: 400 });
    if (lista.length > MAX_ARCHIVOS) throw Object.assign(new Error(`Sube hasta ${MAX_ARCHIVOS} archivos a la vez.`), { status: 400 });
    return lista.map((a, i) => {
      const nombre = L.txt(a && a.nombre, 120) || `Archivo ${i + 1}`;
      if (!a || !Array.isArray(a.filas) || !a.filas.length) throw Object.assign(new Error(`${nombre}: no se pudo leer o está vacío.`), { status: 400 });
      if (a.filas.length > MAX_FILAS + 15) throw Object.assign(new Error(`${nombre} tiene más de ${MAX_FILAS.toLocaleString('en-US')} filas. Bájalo por partes (por ejemplo, por año) y súbelos juntos.`), { status: 400 });
      const filas = a.filas.map((f) => (Array.isArray(f) ? f.slice(0, MAX_COLUMNAS).map((c) => (c == null ? '' : String(c).slice(0, MAX_CELDA))) : []));
      // -1 = no trae encabezados (la primera fila ya es un cliente): van "Columna 1, 2…" y
      // el negocio escoge en el resumen qué es cada una.
      const hi = L.encontrarEncabezado(filas);
      const ancho = Math.max(0, ...filas.slice(0, 50).map((f) => f.length));
      const encabezados = hi < 0 ? Array.from({ length: ancho }, (_, j) => `Columna ${j + 1}`) : L.encabezadosUnicos(filas[hi] || []);
      if (encabezados.length < 2) throw Object.assign(new Error(`${nombre}: no encontré las columnas. Cada dato tiene que ir en su columna (nombre, teléfono…).`), { status: 400 });
      const tipo = tiene(L.TIPOS, a.tipo) ? a.tipo : null;
      return { nombre, encabezados, filas: filas.slice(hi + 1), primeraFila: hi + 2, tipo, mapa: null, porIA: false, quitado: false, sinEncabezados: hi < 0 };
    });
  }

  function mapaValido(tipo, mapa, encabezados) {
    const out = {};
    for (const campo of Object.keys(L.TIPOS[tipo].campos)) {
      const v = mapa && tiene(mapa, campo) ? mapa[campo] : null;
      out[campo] = typeof v === 'string' && encabezados.includes(v) ? v : null;
    }
    // un encabezado no puede ser dos campos: gana el primero
    const usados = new Set();
    for (const c of Object.keys(out)) { if (out[c] && usados.has(out[c])) out[c] = null; else if (out[c]) usados.add(out[c]); }
    return out;
  }

  async function columnasConIA(bid, plataforma, a, tipoPedido) {
    if (!claude() || !gastarIA(bid)) return null;
    const muestra = a.filas.filter((f) => f.some((c) => L.txt(c, 5))).slice(0, 3);
    // Un encabezado raro puede ser un dato (una lista sin encabezados trae un cliente
    // arriba): esos van como "Columna N" y se traducen de vuelta al contestar.
    const alias = a.encabezados.map((hdr, j) => (L.encabezadoConocido(hdr) ? hdr : `Columna ${j + 1}`));
    const lineas = alias.map((hdr, j) => `- "${hdr}": ${muestra.map((f) => L.tapar(f[j]) || '(vacío)').join(' | ')}`);
    const contenido = [
      `Plataforma: ${tiene(PLATAFORMAS, plataforma) ? PLATAFORMAS[plataforma] : 'otra'}`,
      tipoPedido ? `El negocio dice que es un archivo de: ${tipoPedido}` : '',
      'Encabezados y forma de unas filas:',
      ...lineas,
    ].filter(Boolean).join('\n');
    try {
      const j = await preguntarClaude(SISTEMA_COLUMNAS, contenido, ESQUEMA_COLUMNAS);
      const tipo = tipoPedido || (tiene(L.TIPOS, j.tipo) ? j.tipo : null);
      if (!tipo) return { tipo: null };
      const real = {};
      for (const [c, v] of Object.entries(j.columnas || {})) { const k = alias.indexOf(v); if (k >= 0) real[c] = a.encabezados[k]; }
      return { tipo, mapa: mapaValido(tipo, real, a.encabezados) };
    } catch (e) {
      console.error('mudanza IA columnas:', e.message);
      return null;
    }
  }

  // Tipo y columnas de un archivo: lo seguro primero (los encabezados de siempre); Claude
  // solo si no queda claro, y lo que diga solo llena los campos que faltaban.
  async function reconocer(bid, plataforma, a) {
    if (a.tipo && a.mapa) return a;
    if (a.tipo) {
      a.mapa = L.mapear(a.tipo, a.encabezados);
      if (!L.completo(a.tipo, a.mapa)) {
        const ia = await columnasConIA(bid, plataforma, a, a.tipo);
        if (ia && ia.mapa) { a.mapa = juntar(a.mapa, ia.mapa); a.porIA = true; }
      }
      return a;
    }
    const d = L.detectar(a.encabezados);
    a.tipo = d.tipo || L.ORDEN_TIPOS.slice().sort((x, y) => Object.values(d.mapas[y]).filter(Boolean).length - Object.values(d.mapas[x]).filter(Boolean).length)[0];
    a.mapa = d.mapas[a.tipo];
    if (d.dudoso) {
      const ia = await columnasConIA(bid, plataforma, a, null);
      if (ia && ia.tipo) {
        a.tipo = ia.tipo;
        a.mapa = juntar(L.mapear(ia.tipo, a.encabezados), ia.mapa);
        a.porIA = true;
      }
    }
    return a;
  }
  function juntar(seguro, ia) {
    const out = { ...seguro };
    const usados = new Set(Object.values(out).filter(Boolean));
    for (const [c, v] of Object.entries(ia || {})) if (!out[c] && v && !usados.has(v)) { out[c] = v; usados.add(v); }
    return out;
  }

  // ---------- El plan: lo que pasaría, calculado igual para el resumen y para mudar ----------
  async function contexto(cx, bid) {
    const [clientes, servicios, equipo, lealtad, gift, codigosViejos, paquetesViejos, lealtadVieja, anteriores] = await Promise.all([
      cx.query(`SELECT id, full_name, phone, email::text AS email, notes, import_source, imported_visits,
                       imported_spent_cents, imported_last_visit_at
                  FROM clients WHERE business_id = $1`, [bid]),
      cx.query(`SELECT id, name, duration_min, price_cents FROM services WHERE business_id = $1 AND deleted_at IS NULL`, [bid]),
      cx.query(`SELECT id, display_name FROM staff WHERE business_id = $1 AND deleted_at IS NULL AND is_active ORDER BY sort_order, created_at`, [bid]),
      cx.query(`SELECT visits_required FROM loyalty_programs WHERE business_id = $1`, [bid]),
      cx.query(`SELECT 1 FROM addons WHERE business_id = $1 AND code = 'gift_cards' AND status = 'active'
                   AND (current_period_end IS NULL OR now() <= current_period_end + interval '7 days')`, [bid]).catch(() => ({ rows: [] })),
      // Lo que ya pasó en otra mudanza, para no pasarlo dos veces (una mudanza que el negocio
      // creyó fallida porque tardó, o el mismo archivo subido otra vez).
      cx.query(`SELECT legacy_code FROM gift_cards WHERE business_id = $1 AND legacy_code IS NOT NULL`, [bid]),
      cx.query(`SELECT client_id, lower(name) AS name FROM memberships
                 WHERE business_id = $1 AND mudanza_id IS NOT NULL AND status = 'active' AND client_id IS NOT NULL`, [bid]),
      cx.query(`SELECT DISTINCT lp.client_id FROM mudanza_items mi
                  JOIN mudanzas m ON m.id = mi.mudanza_id AND m.status = 'done'
                  JOIN loyalty_progress lp ON lp.id = mi.entity_id
                 WHERE m.business_id = $1 AND mi.entity = 'loyalty'`, [bid]),
      cx.query(`SELECT platform, done_at FROM mudanzas WHERE business_id = $1 AND status = 'done' ORDER BY done_at DESC LIMIT 5`, [bid]),
    ]);
    // Un cliente de Bukéame se reconoce por teléfono o email, nunca solo por el nombre:
    // dos personas se pueden llamar igual y la otra recibiría los recordatorios o el saldo.
    const porTel = new Map(), porEmail = new Map();
    for (const c of clientes.rows) {
      porTel.set(c.phone, c);
      if (c.email) porEmail.set(c.email.toLowerCase(), porEmail.has(c.email.toLowerCase()) ? false : c);
    }
    const serv = new Map(servicios.rows.map((s) => [nombreClave(s.name), s]));
    return {
      porTel, porEmail, serv,
      equipo: equipo.rows.map((s) => ({ id: s.id, nombre: s.display_name })),
      lealtadReq: lealtad.rows[0] ? lealtad.rows[0].visits_required : null,
      giftActivo: !!gift.rows[0],
      codigosViejos: new Set(codigosViejos.rows.map((r) => r.legacy_code)),
      paquetesViejos: new Set(paquetesViejos.rows.map((r) => `${r.client_id}|${r.name}`)),
      lealtadVieja: new Set(lealtadVieja.rows.map((r) => r.client_id)),
      anteriores: anteriores.rows,
    };
  }

  function opcionesDe(o) {
    o = o || {};
    const n = (v, min, max, def) => (Number.isInteger(v) && v >= min && v <= max ? v : def);
    const staff_map = {};
    if (o.staff_map && typeof o.staff_map === 'object') {
      for (const [k, v] of Object.entries(o.staff_map).slice(0, 200)) if (k.length <= 80 && isUuid(v)) staff_map[k] = v;
    }
    return {
      recordatorios: o.recordatorios !== false,
      lealtad_cada: n(o.lealtad_cada, 1, 1000, 1),
      paquetes_meses: n(o.paquetes_meses, 1, 24, 6),
      staff_map,
    };
  }

  async function planificar(cx, biz, draft) {
    const bid = biz.id;
    const fuente = draft.plataforma;
    const ahora = new Date();
    const cxo = await contexto(cx, bid);
    const op = opcionesDe(draft.opciones);
    const lectura = { normPhone, isEmail, ahora };
    const archivos = draft.archivos.map((a, i) => {
      if (a.quitado) return { i, a, r: { items: [], fuera: [], repetidos: 0, canceladas: 0 } };
      return { i, a, r: L.normalizar(a.tipo, a.encabezados, a.filas, a.mapa, { ...lectura, primeraFila: a.primeraFila, orden: a.orden }) };
    });
    const de = (tipo) => archivos.filter((x) => !x.a.quitado && x.a.tipo === tipo);

    // Clientes: los del archivo de clientes, más los que aparecen en citas, paquetes y puntos.
    const clientes = new Map();   // clave → { phone, full_name, email, notes, visits, spent_cents, last_visit, existe }
    const ponerCliente = (c, fila) => {
      const ya = clientes.get(c.phone);
      if (ya) {
        for (const k of ['email', 'notes', 'visits', 'spent_cents', 'last_visit']) if (ya[k] == null && c[k] != null) ya[k] = c[k];
        if ((!ya.full_name || ya.full_name === 'Sin nombre') && c.full_name) ya.full_name = c.full_name;
        return ya;
      }
      const nuevo = { phone: c.phone, full_name: c.full_name || 'Sin nombre', email: c.email || null, notes: c.notes || null,
        visits: c.visits ?? null, spent_cents: c.spent_cents ?? null, last_visit: c.last_visit || null,
        existe: cxo.porTel.get(c.phone) || null, fila };
      clientes.set(c.phone, nuevo);
      return nuevo;
    };
    for (const x of de('clientes')) for (const it of x.r.items) ponerCliente(it, it.fila);
    const delArchivo = { email: new Map(), nombre: new Map() };
    for (const c of clientes.values()) {
      if (c.email) delArchivo.email.set(c.email, delArchivo.email.has(c.email) ? false : c.phone);
      const k = nombreClave(c.full_name);
      if (k && c.full_name !== 'Sin nombre') delArchivo.nombre.set(k, delArchivo.nombre.has(k) ? false : c.phone);
    }
    // ¿Quién es? Teléfono; si no, email; si no, el nombre, pero solo entre los clientes de
    // los archivos de esta mudanza (que traen su teléfono) y si no hay dos que se llamen igual.
    const resolver = (cl) => {
      if (cl.phone) { ponerCliente({ phone: cl.phone, full_name: cl.name, email: cl.email }); return cl.phone; }
      if (cl.email) {
        const e = cl.email.toLowerCase();
        if (delArchivo.email.get(e)) return delArchivo.email.get(e);
        if (cxo.porEmail.get(e)) return 'id:' + cxo.porEmail.get(e).id;
      }
      const k = nombreClave(cl.name);
      if (k && delArchivo.nombre.get(k)) return delArchivo.nombre.get(k);
      return null;
    };
    const idDeClave = (clave) => (clave.startsWith('id:') ? clave.slice(3) : (cxo.porTel.get(clave) || {}).id || null);
    const sinCliente = (x, it) => x.r.fuera.push({ fila: it.fila, motivo: 'no sé quién es el cliente (sin teléfono)', texto: L.txt([it.client.name, it.client.email].filter(Boolean).join(' · '), 90) });

    // Servicios nuevos (los que ya están en Bukéame se quedan como están).
    const serviciosNuevos = [];
    let serviciosYa = 0;
    for (const x of de('servicios')) {
      x.ya = 0;
      for (const it of x.r.items) {
        const k = nombreClave(it.name);
        if (cxo.serv.has(k) || serviciosNuevos.some((s) => nombreClave(s.name) === k)) { serviciosYa++; x.ya++; continue; }
        serviciosNuevos.push(it);
      }
    }
    const servicioDe = (nombre) => {
      const k = nombreClave(nombre);
      return cxo.serv.get(k) || serviciosNuevos.find((s) => nombreClave(s.name) === k) || null;
    };

    // Citas: las futuras van a la agenda; las pasadas, al historial del cliente.
    const futuras = new Map(), historial = [];
    const nombresStaff = new Map();
    for (const x of de('citas')) {
      x.futuras = 0; x.pasadas = 0;
      for (const it of x.r.items) {
        const clave = resolver(it.client);
        if (!clave) { sinCliente(x, it); continue; }
        if (it.futura) {
          const st = it.staff || '';
          nombresStaff.set(st, (nombresStaff.get(st) || 0) + 1);
          const k = `${clave}|${nombreClave(st)}|${it.start}`;
          const ya = futuras.get(k);
          if (ya) {   // la misma cita en dos filas (un servicio por fila): se juntan
            if (it.service) ya.services.push(it.service);
            ya.duration_min = (ya.duration_min || 0) + (it.duration_min || 0) || null;
            if (it.price_cents != null) ya.price_cents = (ya.price_cents || 0) + it.price_cents;
            continue;
          }
          futuras.set(k, { ...it, clave, services: it.service ? [it.service] : [], archivo: x.i });
          x.futuras++;
        } else {
          historial.push({ clave, occurred_at: it.start, service_name: it.service, staff_name: it.staff,
            price_cents: it.price_cents, status: it.estado === 'no_show' ? 'no_show' : 'completed' });
          x.pasadas++;
        }
      }
    }
    // A quién en el equipo de Bukéame le toca cada nombre del archivo.
    const equipoPorNombre = new Map(cxo.equipo.map((s) => [nombreClave(s.nombre), s.id]));
    const equipoPorPrimer = new Map();
    for (const s of cxo.equipo) {
      const p = nombreClave(String(s.nombre).split(' ')[0]);
      equipoPorPrimer.set(p, equipoPorPrimer.has(p) ? false : s.id);
    }
    const profesionales = [...nombresStaff.entries()].map(([nombre, citas]) => {
      const pedido = op.staff_map[nombre];
      let staff_id = isUuid(pedido) && cxo.equipo.some((s) => s.id === pedido) ? pedido : null;
      if (!staff_id) staff_id = equipoPorNombre.get(nombreClave(nombre)) || equipoPorPrimer.get(nombreClave(nombre.split(' ')[0])) || (cxo.equipo[0] && cxo.equipo[0].id) || null;
      return { nombre, citas, staff_id };
    }).sort((a, b) => b.citas - a.citas);
    const staffDe = (nombre) => (profesionales.find((p) => p.nombre === (nombre || '')) || {}).staff_id || null;
    const citas = [...futuras.values()].map((c) => {
      const s = c.services.length === 1 ? servicioDe(c.services[0]) : null;
      const dur = c.duration_min || (s && s.duration_min) || 30;
      // El nombre del servicio sale en los recordatorios: sin enlaces.
      const nombres = c.services.map((n) => (ENLACE.test(n) ? 'Servicio' : n));
      return {
        ...c, staff_id: staffDe(c.staff), service_id: s && s.id ? s.id : null,
        service_name: nombres.length ? nombres.join(' + ').slice(0, 200) : (s ? s.name : 'Servicio'),
        duration_min: Math.min(480, Math.max(5, dur)),
        price_cents: c.price_cents != null ? c.price_cents : (s ? s.price_cents : 0),
      };
    }).sort((x, y) => (x.start < y.start ? -1 : 1));
    // Choques: con citas que ya están en Bukéame y entre las mismas del archivo.
    let choques = 0;
    if (citas.length) {
      const desde = citas[0].start;
      const hasta = new Date(Math.max(...citas.map((c) => new Date(c.start).getTime() + c.duration_min * 60_000)));
      const vivas = await cx.query(
        `SELECT staff_id, starts_at, ends_at FROM appointments
          WHERE business_id = $1 AND status = ANY($2) AND starts_at < $4 AND ends_at > $3`, [bid, ALIVE, desde, hasta]);
      const ocupado = vivas.rows.map((r) => ({ staff_id: r.staff_id, a: new Date(r.starts_at).getTime(), b: new Date(r.ends_at).getTime() }));
      citas.forEach((c, k) => {
        const a = new Date(c.start).getTime(), b = a + c.duration_min * 60_000;
        if (k >= MAX_CITAS) c.motivo = `pasa del tope de ${MAX_CITAS.toLocaleString('en-US')} citas por mudanza`;
        else if (!c.staff_id) c.motivo = 'sin profesional';
        else if (ocupado.some((o) => o.staff_id === c.staff_id && o.a < b && o.b > a)) c.motivo = 'choca con otra cita';
        c.choca = !!c.motivo;
        if (c.choca) choques++;
        else ocupado.push({ staff_id: c.staff_id, a, b });
      });
    }
    // Recordatorios: el WhatsApp es el mismo para todos los negocios, así que una mudanza
    // pone recordatorio a lo sumo a 60 citas por día; las demás pasan sin recordatorio.
    let sinRecordatorio = 0;
    const porDia = new Map();
    for (const c of citas) {
      if (c.choca) continue;
      const dia = new Date(new Date(c.start).getTime() - 4 * 3600_000).toISOString().slice(0, 10);
      const n = (porDia.get(dia) || 0) + 1;
      porDia.set(dia, n);
      c.recordatorio = op.recordatorios && n <= RECORDATORIOS_DIA;
      if (op.recordatorios && !c.recordatorio) sinRecordatorio++;
    }
    // ¿Se pasa del tope de citas del mes de su plan? No se bloquea (son sus citas), pero se avisa.
    let topeMes = null;
    if (biz.max_appts_month != null) {
      const mes = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 7);
      const deEsteMes = citas.filter((c) => !c.choca && new Date(new Date(c.start).getTime() - 4 * 3600_000).toISOString().slice(0, 7) === mes).length;
      if (deEsteMes) {
        const ya = (await cx.query(
          `SELECT count(*)::int n FROM appointments WHERE business_id = $1 AND date_trunc('month', starts_at) = date_trunc('month', now())
              AND status <> 'cancelled_client' AND status <> 'cancelled_business'`, [bid])).rows[0].n;
        if (ya + deEsteMes >= biz.max_appts_month) topeMes = { tope: biz.max_appts_month, con: ya + deEsteMes };
      }
    }

    // Resumen de antes de Bukéame por cliente: lo que diga su archivo o lo que sume su historial.
    const porClave = new Map();
    for (const v of historial) {
      const s = porClave.get(v.clave) || { visits: 0, spent: 0, last: null };
      if (v.status === 'completed') { s.visits++; s.spent += v.price_cents || 0; }
      if (!s.last || v.occurred_at > s.last) s.last = v.occurred_at;
      porClave.set(v.clave, s);
    }
    for (const [clave, s] of porClave) {
      const c = clave.startsWith('id:') ? null : clientes.get(clave);
      if (!c) continue;
      c.visits = Math.max(c.visits || 0, s.visits);
      c.spent_cents = Math.max(c.spent_cents || 0, s.spent);
      if (s.last && (!c.last_visit || s.last > c.last_visit)) c.last_visit = s.last;
    }
    const historialIds = [...porClave.entries()].filter(([k]) => k.startsWith('id:')).map(([k, s]) => ({ id: k.slice(3), ...s }));

    const ventas = de('ventas').flatMap((x) => x.r.items);
    // Saldos: lo que ya se pasó en otra mudanza no se pasa otra vez (sería deberle dos veces).
    const yaPaso = (x, it, que) => x.r.fuera.push({ fila: it.fila, motivo: `ya se pasó en una mudanza anterior (${que})`, texto: L.txt(it.code || (it.client && it.client.name) || '', 90) });
    const tarjetas = [], paquetes = [], lealtad = [];
    for (const x of de('tarjetas')) {
      x.resueltos = 0;
      for (const it of x.r.items) {
        if (cxo.codigosViejos.has(it.code)) { yaPaso(x, it, 'la tarjeta'); continue; }
        tarjetas.push(it);
        x.resueltos++;
      }
    }
    for (const x of de('paquetes')) {
      x.resueltos = 0;
      for (const it of x.r.items) {
        const clave = resolver(it.client);
        if (!clave) { sinCliente(x, it); continue; }
        const cid = idDeClave(clave);
        if (cid && cxo.paquetesViejos.has(`${cid}|${it.name.toLowerCase()}`)) { yaPaso(x, it, 'el paquete'); continue; }
        paquetes.push({ ...it, clave });
        x.resueltos++;
      }
    }
    for (const x of de('lealtad')) {
      x.resueltos = 0;
      if (cxo.lealtadReq == null) { x.sinPrograma = true; continue; }
      for (const it of x.r.items) {
        const clave = resolver(it.client);
        if (!clave) { sinCliente(x, it); continue; }
        const cid = idDeClave(clave);
        if (cid && cxo.lealtadVieja.has(cid)) { yaPaso(x, it, 'sus puntos'); continue; }
        const visitas = Math.floor(it.count / op.lealtad_cada);
        if (visitas > 0) { lealtad.push({ clave, visitas }); x.resueltos++; }
        else x.r.fuera.push({ fila: it.fila, motivo: `menos de ${op.lealtad_cada} puntos (no llega a una visita)`, texto: L.txt(it.client.name, 90) });
      }
    }

    return { fuente, op, cxo, archivos, clientes, serviciosNuevos, serviciosYa, citas, choques, historial, historialIds,
      ventas, tarjetas, paquetes, lealtad, profesionales, sinRecordatorio, topeMes };
  }

  // ---------- Lo que ve el negocio antes de confirmar ----------
  function muestra(tipo, items) {
    const m = items.slice(0, 5);
    switch (tipo) {
      case 'clientes': return { cols: ['Nombre', 'Teléfono', 'Email'], filas: m.map((x) => [x.full_name, telBonito(x.phone), x.email || '']) };
      case 'servicios': return { cols: ['Servicio', 'Duración', 'Precio'], filas: m.map((x) => [x.name, x.duration_min + ' min' + (x.sin_duracion ? ' (no la decía)' : ''), x.sin_precio ? 'sin precio' : dinero(x.price_cents)]) };
      case 'citas': return { cols: ['Fecha', 'Cliente', 'Servicio', 'Profesional'], filas: m.map((x) => [fechaPR(x.start, x.futura), x.client.name || telBonito(x.client.phone) || x.client.email, x.service || '', x.staff || '']) };
      case 'ventas': return { cols: ['Fecha', 'Total', 'Qué se vendió'], filas: m.map((x) => [fechaPR(x.sold_at), dinero(x.amount_cents), x.description || '']) };
      case 'tarjetas': return { cols: ['Código', 'Saldo', 'Para'], filas: m.map((x) => [x.code, dinero(x.balance_cents), x.recipient_name || x.recipient_email || '']) };
      case 'paquetes': return { cols: ['Cliente', 'Paquete', 'Le quedan'], filas: m.map((x) => [x.client.name || telBonito(x.client.phone), x.name, String(x.remaining)]) };
      case 'lealtad': return { cols: ['Cliente', 'Puntos'], filas: m.map((x) => [x.client.name || telBonito(x.client.phone), String(x.count)]) };
      default: return { cols: [], filas: [] };
    }
  }

  function resumen(m, draft, plan) {
    const archivos = plan.archivos.map(({ i, a, r }) => {
      const t = L.TIPOS[a.tipo];
      const base = {
        i, nombre: a.nombre, tipo: a.tipo, quitado: !!a.quitado, encabezados: a.encabezados, mapa: a.mapa, porIA: !!a.porIA,
        campos: Object.entries(t.campos).map(([k, f]) => ({ k, e: f.e, requerido: t.requiere.some((g) => g.length === 1 && g[0] === k) })),
        faltan: L.faltan(a.tipo, a.mapa), filas: a.filas.filter((f) => f.some((c) => L.txt(c, 5))).length,
        pasan: r.items.length, repetidos: r.repetidos, canceladas: r.canceladas,
        fuera_n: r.fuera.length, fuera: r.fuera.slice(0, 40), muestra: muestra(a.tipo, r.items), avisos: [],
      };
      const x = plan.archivos[i];
      if (a.tipo === 'servicios') base.ya = x.ya || 0;
      if (a.tipo === 'citas') { base.futuras = x.futuras || 0; base.pasadas = x.pasadas || 0; base.pasan = base.futuras + base.pasadas; }
      if (a.tipo === 'paquetes' || a.tipo === 'lealtad' || a.tipo === 'tarjetas') base.pasan = x.resueltos || 0;
      if (a.sinEncabezados) base.avisos.push('Este archivo no trae los nombres de las columnas. Abre Columnas y escoge qué es cada una.');
      // Fechas que se leen de dos maneras (05/03): el negocio escoge cómo vienen.
      base.fechas_dudosas = !!(r.fechasDudosas || a.orden);
      base.orden = a.orden || 'mdy';
      if (r.fechasDudosas) base.avisos.push('Las fechas de este archivo se pueden leer de dos maneras (05/03 puede ser 3 de mayo o 5 de marzo). Escoge abajo cómo vienen.');
      if (a.tipo === 'lealtad' && x.sinPrograma) { base.avisos.push('Primero crea tu programa de lealtad (en Lealtad). Hasta entonces estos puntos no se pasan.'); base.pasan = 0; }
      if (a.tipo === 'tarjetas' && !plan.cxo.giftActivo && r.items.length) base.avisos.push('Para cobrar con estas tarjetas en Bukéame necesitas el add-on de Gift cards.');
      if (a.tipo === 'citas' && x.futuras && !plan.cxo.equipo.length) base.avisos.push('Primero añade tu equipo (en Equipo): cada cita va con su profesional.');
      if (a.tipo === 'tarjetas' && x.resueltos) base.avisos.push('Cada tarjeta lleva un código nuevo de Bukéame. El de antes queda guardado y al final te doy la lista para avisarle a cada cliente.');
      return base;
    });
    const nuevos = [...plan.clientes.values()].filter((c) => !c.existe).length;
    const conHistorial = plan.historial.length;
    // Avisos de toda la mudanza.
    const avisos = [];
    const antes = plan.cxo.anteriores.find((x) => x.platform === draft.plataforma) || plan.cxo.anteriores[0];
    if (antes) avisos.push(`Ya hiciste una mudanza desde ${tiene(PLATAFORMAS, antes.platform) ? PLATAFORMAS[antes.platform] : 'otra plataforma'} el ${fechaPR(antes.done_at)}. Lo que ya pasó (clientes, servicios, saldos, ventas y visitas) no se vuelve a pasar.`);
    if (plan.sinRecordatorio) avisos.push(`${plan.sinRecordatorio} ${plan.sinRecordatorio === 1 ? 'cita pasa' : 'citas pasan'} sin recordatorio: cada mudanza pone recordatorios a ${RECORDATORIOS_DIA} citas por día como máximo.`);
    if (plan.topeMes) avisos.push(`Tu plan trae ${plan.topeMes.tope} citas al mes. Con estas llegas a ${plan.topeMes.con} y este mes tus clientes no podrán reservar en línea. Puedes subir de plan en Mi cuenta.`);
    return {
      avisos,
      id: m.id, plataforma: draft.plataforma, plataforma_nombre: tiene(PLATAFORMAS, draft.plataforma) ? PLATAFORMAS[draft.plataforma] : 'otra plataforma',
      ia: !!claude(),
      tipos: L.ORDEN_TIPOS.map((k) => ({ k, nombre: L.TIPOS[k].nombre })),
      archivos,
      equipo: plan.cxo.equipo,
      profesionales: plan.profesionales,
      opciones: { recordatorios: plan.op.recordatorios, lealtad_cada: plan.op.lealtad_cada, paquetes_meses: plan.op.paquetes_meses },
      lealtad_visitas: plan.cxo.lealtadReq,
      necesita_saldos: !!(plan.tarjetas.length || plan.paquetes.length || plan.lealtad.length),
      totales: {
        clientes_nuevos: nuevos, clientes_completados: plan.clientes.size - nuevos,
        servicios_nuevos: plan.serviciosNuevos.length, servicios_ya: plan.serviciosYa,
        citas_futuras: plan.citas.length - plan.choques, choques: plan.choques,
        historial: conHistorial,
        ventas: plan.ventas.length, ventas_cents: plan.ventas.reduce((s, v) => s + v.amount_cents, 0),
        tarjetas: plan.tarjetas.length, tarjetas_cents: plan.tarjetas.reduce((s, t) => s + t.balance_cents, 0),
        paquetes: plan.paquetes.length, lealtad: plan.lealtad.length,
        fuera: archivos.reduce((s, a) => s + (a.quitado ? 0 : a.fuera_n), 0),
      },
    };
  }

  async function borradorDe(bid, id, cx = db) {
    if (!isUuid(id)) return null;
    const { rows } = await cx.query(
      `SELECT * FROM mudanzas WHERE id = $1 AND business_id = $2 AND status = 'draft'
          AND updated_at > now() - interval '24 hours'${cx === db ? '' : ' FOR UPDATE'}`, [id, bid]);
    return rows[0] || null;
  }

  // ---------- Rutas del panel ----------
  app.get('/api/mudanza', ...PANEL, asyncH(async (req, res) => {
    const bid = req.business.id;
    await db.query(`UPDATE mudanzas SET status = 'expired', draft = NULL
                     WHERE business_id = $1 AND status = 'draft' AND updated_at < now() - interval '24 hours'`, [bid]);
    const { rows } = await db.query(
      `SELECT id, platform, status, summary, created_at, done_at, undone_at,
              (status = 'done' AND done_at > now() - make_interval(days => $2)) AS puede_deshacer
         FROM mudanzas WHERE business_id = $1 AND status IN ('done','undone','draft')
        ORDER BY created_at DESC LIMIT 20`, [bid, DESHACER_DIAS]);
    res.json({
      ia: !!claude(), deshacer_dias: DESHACER_DIAS,
      plataformas: Object.entries(PLATAFORMAS).map(([k, nombre]) => ({ k, nombre })),
      mudanzas: rows.map((r) => ({ ...r, plataforma_nombre: PLATAFORMAS[r.platform] || r.platform })),
    });
  }));

  // El id va con su forma para que /api/mudanza/ventas no caiga aquí.
  app.get('/api/mudanza/:id([0-9a-fA-F-]{36})', ...PANEL, asyncH(async (req, res) => {
    const m = await borradorDe(req.business.id, req.params.id);
    if (!m) return bad(res, 'Ese borrador ya no está (se borran a las 24 horas). Sube los archivos otra vez.', 404);
    res.json(resumen(m, m.draft, await planificar(db, req.business, m.draft)));
  }));

  // Nuevo borrador, o más archivos para uno que ya existe.
  app.post('/api/mudanza/analizar', ...PANEL, limiteAnalisis, cuerpoGrande, asyncH(async (req, res) => {
    const bid = req.business.id;
    const { id, plataforma } = req.body || {};
    let archivos;
    try { archivos = leerArchivos(req.body && req.body.archivos); } catch (e) { return bad(res, e.message, e.status || 400); }
    let m = id ? await borradorDe(bid, id) : null;
    if (id && !m) return bad(res, 'Ese borrador ya no está (se borran a las 24 horas). Sube los archivos otra vez.', 404);
    const plat = m ? m.platform : (tiene(PLATAFORMAS, plataforma) ? plataforma : 'otra');
    const draft = m ? m.draft : { plataforma: plat, archivos: [], opciones: {} };
    // Topes del borrador (antes de gastar en la IA): archivos activos, todos (con los quitados) y filas.
    if (draft.archivos.filter((a) => !a.quitado).length + archivos.length > MAX_ARCHIVOS || draft.archivos.length + archivos.length > MAX_ARCHIVOS_BORRADOR)
      return bad(res, `Una mudanza lleva hasta ${MAX_ARCHIVOS} archivos. Haz otra mudanza con los demás.`);
    if ([...draft.archivos, ...archivos].reduce((n, a) => n + a.filas.length, 0) > MAX_FILAS_BORRADOR)
      return bad(res, `Una mudanza lleva hasta ${MAX_FILAS_BORRADOR.toLocaleString('en-US')} filas en total. Muda esto primero y haz otra con lo demás.`);
    for (const a of archivos) await reconocer(bid, plat, a);
    draft.archivos.push(...archivos);
    if (m) {
      // Solo si sigue siendo borrador: si se mudó mientras tanto, las filas no vuelven a guardarse.
      m = (await db.query(`UPDATE mudanzas SET draft = $2, updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING *`, [m.id, draft])).rows[0];
      if (!m) return bad(res, 'Esa mudanza ya se hizo. Empieza otra para subir más archivos.', 404);
    } else {
      m = (await db.query(
        `INSERT INTO mudanzas (business_id, platform, draft, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
        [bid, plat, draft, req.user.id])).rows[0];
    }
    res.json(resumen(m, draft, await planificar(db, req.business, draft)));
  }));

  // El negocio corrige el tipo o una columna, quita un archivo o cambia una opción.
  app.post('/api/mudanza/:id/ajustar', ...PANEL, limiteAnalisis, cuerpo, asyncH(async (req, res) => {
    const bid = req.business.id;
    let m = await borradorDe(bid, req.params.id);
    if (!m) return bad(res, 'Ese borrador ya no está (se borran a las 24 horas). Sube los archivos otra vez.', 404);
    const draft = m.draft;
    const cambios = Array.isArray(req.body && req.body.archivos) ? req.body.archivos.slice(0, MAX_ARCHIVOS * 2) : [];
    for (const c of cambios) {
      const a = Number.isInteger(c && c.i) ? draft.archivos[c.i] : null;
      if (!a) continue;
      if (c.quitar === true) { a.quitado = true; continue; }
      if (c.quitar === false && a.quitado && draft.archivos.filter((y) => !y.quitado).length < MAX_ARCHIVOS) a.quitado = false;
      if (c.orden === 'mdy' || c.orden === 'dmy') a.orden = c.orden;
      if (tiene(L.TIPOS, c.tipo) && c.tipo !== a.tipo) {
        a.tipo = c.tipo; a.porIA = false;
        if (c.mapa) a.mapa = mapaValido(a.tipo, c.mapa, a.encabezados);
        else { a.mapa = null; await reconocer(bid, draft.plataforma, a); }
      } else if (c.mapa && typeof c.mapa === 'object') {
        a.mapa = mapaValido(a.tipo, { ...a.mapa, ...c.mapa }, a.encabezados);
      }
    }
    if (req.body && req.body.opciones) draft.opciones = { ...draft.opciones, ...opcionesDe({ ...draft.opciones, ...req.body.opciones }) };
    m = (await db.query(`UPDATE mudanzas SET draft = $2, updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING *`, [m.id, draft])).rows[0];
    if (!m) return bad(res, 'Esa mudanza ya se hizo.', 404);
    res.json(resumen(m, draft, await planificar(db, req.business, draft)));
  }));

  // La foto de la lista de precios → servicios para revisar (la foto no se guarda).
  app.post('/api/mudanza/foto', ...PANEL, limiteAnalisis, cuerpoGrande, asyncH(async (req, res) => {
    const img = String((req.body && req.body.imagen) || '');
    const mt = img.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!mt) return bad(res, 'Sube una foto en JPG, PNG o WebP.');
    const bytes = Buffer.from(mt[2], 'base64');
    if (bytes.length > 5 * 1024 * 1024) return bad(res, 'La foto pesa más de 5 MB. Tómala otra vez o recórtala.');
    const firma = bytes.slice(0, 12).toString('hex');
    const esImagen = firma.startsWith('ffd8ff') || firma.startsWith('89504e47') || (firma.startsWith('52494646') && bytes.slice(8, 12).toString() === 'WEBP');
    if (!esImagen) return bad(res, 'Eso no parece una foto.');
    if (!claude()) return bad(res, 'Leer fotos no está disponible ahora. Escribe tus servicios en el panel o sube un archivo.', 503);
    if (!gastarIA(req.business.id)) return bad(res, 'Ya leíste muchas fotos hoy. Sigue mañana o escribe los servicios en el panel.', 429);
    try {
      const j = await preguntarClaude(SISTEMA_FOTO, [
        { type: 'image', source: { type: 'base64', media_type: mt[1], data: mt[2] } },
        { type: 'text', text: `Negocio: ${req.business.name}. Copia los servicios de esta foto.` },
      ], ESQUEMA_FOTO);
      const servicios = (j.servicios || []).slice(0, 150).map((s) => ({
        nombre: L.txt(s.nombre, 120), precio: L.txt(s.precio, 40), minutos: L.txt(s.minutos, 40),
      })).filter((s) => s.nombre);
      if (!j.legible || !servicios.length) return bad(res, 'No pude leer servicios en esa foto. Prueba con más luz y de frente, o con otra foto.', 422);
      res.json({ servicios });
    } catch (e) {
      console.error('mudanza IA foto:', e.message);
      return bad(res, 'No se pudo leer la foto ahora. Intenta otra vez en un rato.', 502);
    }
  }));

  // ---------- Mudar ----------
  app.post('/api/mudanza/:id/mudar', ...PANEL, cuerpo, asyncH(async (req, res) => {
    const bid = req.business.id;
    const opciones = (req.body && req.body.opciones) || {};
    const cx = await db.connect();
    let resultado;
    try {
      await cx.query('BEGIN');
      await cx.query(`SELECT pg_advisory_xact_lock(hashtext('mudanza:' || $1))`, [bid]);
      const m = await borradorDe(bid, req.params.id, cx);
      if (!m) { await cx.query('ROLLBACK'); return bad(res, 'Ese borrador ya no está (se borran a las 24 horas) o ya se mudó.', 404); }
      const draft = m.draft;
      draft.opciones = { ...draft.opciones, ...opcionesDe({ ...draft.opciones, ...opciones }) };
      const plan = await planificar(cx, req.business, draft);
      if ((plan.tarjetas.length || plan.paquetes.length || plan.lealtad.length) && opciones.saldos_ok !== true) {
        await cx.query('ROLLBACK');
        return bad(res, 'Confirma que revisaste los saldos (tarjetas, paquetes y puntos): son dinero o visitas que les debes a tus clientes.');
      }
      resultado = await ejecutar(cx, req.business, m, plan);
      await cx.query(`UPDATE mudanzas SET status = 'done', done_at = now(), updated_at = now(), draft = NULL, summary = $2 WHERE id = $1`,
        [m.id, resultado]);
      await cx.query('COMMIT');
    } catch (e) {
      await cx.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { cx.release(); }
    await audit(req, 'mudanza.done', 'mudanza', req.params.id, { plataforma: resultado.plataforma, totales: resultado.totales });
    res.json({ ok: true, resumen: resultado });
  }));

  async function ejecutar(cx, biz, m, plan) {
    const bid = biz.id, mid = m.id, fuente = plan.fuente;
    const items = [];   // [entity, entity_id, action, prev]
    const pre = (biz.slug || 'BK').replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() || 'BK';
    const codigo = (tipo) => { let s = ''; for (let i = 0; i < (tipo === 'MEM' ? 6 : 5); i++) s += ALFA[crypto.randomInt(ALFA.length)]; return `${pre}-${tipo}-${s}`; };

    // 1. Servicios nuevos: ligados a todo el equipo activo, como cuando se crean en el panel.
    const servId = new Map([...plan.cxo.serv.entries()].map(([k, s]) => [k, s.id]));
    for (const s of plan.serviciosNuevos) {
      const r = await cx.query(
        `INSERT INTO services (business_id, name, description, duration_min, price_cents) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [bid, s.name, s.description, s.duration_min, s.price_cents]);
      await cx.query(`INSERT INTO service_staff SELECT $1, id FROM staff WHERE business_id = $2 AND is_active AND deleted_at IS NULL ON CONFLICT DO NOTHING`, [r.rows[0].id, bid]);
      servId.set(nombreClave(s.name), r.rows[0].id);
      items.push(['service', r.rows[0].id, 'created', null]);
    }

    // 2. Clientes: los nuevos de un tirón; a los que ya estaban solo se les llena lo que les faltaba.
    const idDe = new Map();
    const nuevos = [], viejos = [];
    for (const c of plan.clientes.values()) (c.existe ? viejos : nuevos).push(c);
    for (let k = 0; k < nuevos.length; k += 2000) {
      const lote = nuevos.slice(k, k + 2000);
      const r = await cx.query(
        `INSERT INTO clients (business_id, full_name, phone, email, notes, import_source, imported_visits, imported_spent_cents, imported_last_visit_at)
         SELECT $1, x.n, x.p, NULLIF(x.e, ''), NULLIF(x.no, ''), $2, x.v, x.s, x.l
           FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::bigint[], $9::timestamptz[]) AS x(n, p, e, no, v, s, l)
         ON CONFLICT (business_id, phone) DO NOTHING
         RETURNING id, phone`,
        [bid, fuente, lote.map((c) => c.full_name.slice(0, 120)), lote.map((c) => c.phone), lote.map((c) => c.email || ''),
         lote.map((c) => (c.notes ? `De ${PLATAFORMAS[fuente] || fuente}: ${c.notes}`.slice(0, 1000) : '')),
         lote.map((c) => c.visits), lote.map((c) => c.spent_cents), lote.map((c) => c.last_visit)]);
      for (const row of r.rows) { idDe.set(row.phone, row.id); items.push(['client', row.id, 'created', null]); }
      // Si alguien lo creó entre el resumen y ahora (una reserva), se trata como uno que ya estaba.
      for (const c of lote) if (!idDe.has(c.phone)) {
        const e = await cx.query(`SELECT id, full_name, phone, email::text AS email, notes, import_source, imported_visits, imported_spent_cents, imported_last_visit_at FROM clients WHERE business_id = $1 AND phone = $2`, [bid, c.phone]);
        if (e.rows[0]) { c.existe = e.rows[0]; viejos.push(c); }
      }
    }
    const COLS = ['email', 'notes', 'import_source', 'imported_visits', 'imported_spent_cents', 'imported_last_visit_at'];
    const ponerViejo = async (id, actual, puso) => {
      const cambia = COLS.filter((c) => puso[c] !== undefined && String(puso[c]) !== String(actual[c]));
      if (!cambia.length) return;
      const antes = Object.fromEntries(cambia.map((c) => [c, actual[c] instanceof Date ? actual[c].toISOString() : actual[c]]));
      const nuevo = Object.fromEntries(cambia.map((c) => [c, puso[c]]));
      await cx.query(`UPDATE clients SET ${cambia.map((c, j) => `${c} = $${j + 3}`).join(', ')} WHERE id = $1 AND business_id = $2`,
        [id, bid, ...cambia.map((c) => nuevo[c])]);
      items.push(['client', id, 'updated', { antes, puso: nuevo }]);
    };
    const fuenteTxt = PLATAFORMAS[fuente] || fuente;
    for (const c of viejos) {
      const e = c.existe;
      idDe.set(c.phone, e.id);
      const puso = {};
      if (!e.email && c.email) puso.email = c.email;
      if (c.notes && !(e.notes || '').includes(c.notes)) puso.notes = [e.notes, `De ${fuenteTxt}: ${c.notes}`].filter(Boolean).join('\n').slice(0, 2000);
      if (!e.import_source) puso.import_source = fuente;
      if (c.visits != null && c.visits > (e.imported_visits || 0)) puso.imported_visits = c.visits;
      if (c.spent_cents != null && c.spent_cents > Number(e.imported_spent_cents || 0)) puso.imported_spent_cents = c.spent_cents;
      if (c.last_visit && (!e.imported_last_visit_at || new Date(c.last_visit) > new Date(e.imported_last_visit_at))) puso.imported_last_visit_at = c.last_visit;
      await ponerViejo(e.id, e, puso);
    }
    // Clientes que ya estaban y se reconocieron por email o nombre: su historial suma.
    for (const s of plan.historialIds) {
      const e = (await cx.query(`SELECT id, imported_visits, imported_spent_cents, imported_last_visit_at, import_source, email::text AS email, notes FROM clients WHERE id = $1 AND business_id = $2`, [s.id, bid])).rows[0];
      if (!e) continue;
      const puso = {};
      if (s.visits > (e.imported_visits || 0)) puso.imported_visits = s.visits;
      if (s.spent > Number(e.imported_spent_cents || 0)) puso.imported_spent_cents = s.spent;
      if (s.last && (!e.imported_last_visit_at || new Date(s.last) > new Date(e.imported_last_visit_at))) puso.imported_last_visit_at = s.last;
      if (!e.import_source) puso.import_source = fuente;
      await ponerViejo(e.id, e, puso);
    }
    const cliente = (clave) => (clave.startsWith('id:') ? clave.slice(3) : idDe.get(clave));

    // 3. Citas futuras a la agenda. La que choca se queda fuera (y se dice cuál).
    let citas = 0;
    const choques = [];
    const recordatorios = plan.op.recordatorios;
    let sinRecordatorio = 0;
    for (const c of plan.citas) {
      const cid = cliente(c.clave);
      const quien = c.client.name || telBonito(c.client.phone) || c.client.email || '';
      if (!cid || !c.staff_id || c.choca) { choques.push({ fila: c.fila, cuando: c.start, quien, motivo: c.motivo || (!c.staff_id ? 'sin profesional' : 'choca con otra cita') }); continue; }
      const start = new Date(c.start);
      const sid = c.service_id || (c.services.length === 1 ? servId.get(nombreClave(c.services[0])) : null) || null;
      for (let intento = 0; intento < 2; intento++) {
        await cx.query('SAVEPOINT cita');
        try {
          const r = await cx.query(
            `INSERT INTO appointments (business_id, client_id, staff_id, service_id, service_name, duration_min, price_cents,
                deposit_cents, starts_at, ends_at, status, source, confirmation_code, client_notes, mudanza_id,
                reminder_24h_sent_at, reminder_2h_sent_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,'confirmed','manual',$10,$11,$12,$13,$13) RETURNING id`,
            [bid, cid, c.staff_id, sid, c.service_name, c.duration_min, Math.max(0, c.price_cents || 0), start,
             new Date(start.getTime() + c.duration_min * 60_000), confirmCode('MD', start), c.notes, mid, c.recordatorio ? null : new Date()]);
          await cx.query('RELEASE SAVEPOINT cita');
          items.push(['appointment', r.rows[0].id, 'created', null]);
          citas++;
          if (recordatorios && !c.recordatorio) sinRecordatorio++;
          break;
        } catch (e) {
          await cx.query('ROLLBACK TO SAVEPOINT cita');
          if (e.code === '23P01') { choques.push({ fila: c.fila, cuando: c.start, quien, motivo: 'choca con otra cita' }); break; }
          if (e.code === '23505' && intento === 0) continue;   // el código salió repetido: otro
          throw e;
        }
      }
    }

    // 4. Visitas de antes (historial del cliente; no son citas).
    // Lo que ya estaba de otra mudanza (misma persona, fecha y servicio) no se repite.
    const hist = plan.historial.map((v) => ({ ...v, cid: cliente(v.clave) })).filter((v) => v.cid);
    let historial = 0;
    for (let k = 0; k < hist.length; k += 5000) {
      const lote = hist.slice(k, k + 5000);
      historial += (await cx.query(
        `INSERT INTO client_import_history (business_id, client_id, mudanza_id, source, occurred_at, service_name, staff_name, price_cents, status)
         SELECT $1, x.c, $2, $3, x.o, x.sn, x.st, x.p, x.es
           FROM unnest($4::uuid[], $5::timestamptz[], $6::text[], $7::text[], $8::int[], $9::text[]) AS x(c, o, sn, st, p, es)
          WHERE NOT EXISTS (SELECT 1 FROM client_import_history h WHERE h.client_id = x.c AND h.occurred_at = x.o
                              AND h.service_name IS NOT DISTINCT FROM x.sn)`,
        [bid, mid, fuente, lote.map((v) => v.cid), lote.map((v) => v.occurred_at), lote.map((v) => v.service_name),
         lote.map((v) => v.staff_name), lote.map((v) => v.price_cents), lote.map((v) => v.status)])).rowCount;
    }

    // 5. Ventas de antes (contabilidad aparte).
    let ventas = 0, ventasCents = 0;
    for (let k = 0; k < plan.ventas.length; k += 5000) {
      const lote = plan.ventas.slice(k, k + 5000);
      const r = await cx.query(
        `INSERT INTO imported_sales (business_id, mudanza_id, source, sold_at, description, client_name, amount_cents, tip_cents, tax_cents, method)
         SELECT $1, $2, $3, x.d, x.de, x.cl, x.a, x.t, x.x, x.me
           FROM unnest($4::timestamptz[], $5::text[], $6::text[], $7::int[], $8::int[], $9::int[], $10::text[]) AS x(d, de, cl, a, t, x, me)
          WHERE NOT EXISTS (SELECT 1 FROM imported_sales s WHERE s.business_id = $1 AND s.sold_at = x.d AND s.amount_cents = x.a
                              AND s.description IS NOT DISTINCT FROM x.de AND s.client_name IS NOT DISTINCT FROM x.cl)
         RETURNING amount_cents`,
        [bid, mid, fuente, lote.map((v) => v.sold_at), lote.map((v) => v.description), lote.map((v) => v.client_name),
         lote.map((v) => v.amount_cents), lote.map((v) => v.tip_cents), lote.map((v) => v.tax_cents), lote.map((v) => v.method)]);
      ventas += r.rowCount;
      ventasCents += r.rows.reduce((n, x) => n + x.amount_cents, 0);
    }

    // 6. Tarjetas de regalo: activas con su saldo y SIEMPRE con código nuevo de Bukéame (al
    //    azar). El viejo puede ser corto o seguido (00001234) y se podría adivinar, y probarlo
    //    contra todos los de Bukéame diría si existe en otro negocio. El viejo queda en legacy_code.
    const codigosNuevos = [];
    let tarjetas = 0;
    for (const t of plan.tarjetas) {
      let code = codigo('GIFT');
      for (let intento = 0; intento < 6; intento++) {
        const usado = await cx.query(`SELECT 1 FROM gift_cards WHERE code = $1`, [code]);
        if (!usado.rows[0]) break;
        code = codigo('GIFT');
      }
      const r = await cx.query(
        `INSERT INTO gift_cards (business_id, code, initial_cents, balance_cents, status, purchaser_name, purchaser_email,
            recipient_name, recipient_email, expires_at, mudanza_id, legacy_code)
         VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [bid, code, t.initial_cents, t.balance_cents, t.purchaser_name, t.purchaser_email, t.recipient_name, t.recipient_email,
         t.expires, mid, t.code]);
      items.push(['gift_card', r.rows[0].id, 'created', { puso: { balance_cents: t.balance_cents } }]);
      codigosNuevos.push({ antes: t.code, ahora: code, para: t.recipient_name || t.recipient_email || '' });
      tarjetas++;
    }

    // 7. Paquetes prepagados → membresías activas con las visitas que le quedan. Van con
    //    precio $0 en Bukéame: se pagaron en la otra plataforma (no son ventas de este mes).
    const finDia = (iso) => {   // medianoche siguiente al último día que vale (días de Puerto Rico)
      const d = new Date(new Date(iso).getTime() - 4 * 3600_000);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 4, 0));
    };
    let paquetes = 0;
    const hoy = new Date();
    for (const p of plan.paquetes) {
      const cid = cliente(p.clave);
      const cl = cid ? (await cx.query(`SELECT full_name, phone, email::text AS email FROM clients WHERE id = $1 AND business_id = $2`, [cid, bid])).rows[0] : null;
      if (!cl) continue;
      const ends = p.expires ? finDia(p.expires) : finDia(new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + plan.op.paquetes_meses, hoy.getUTCDate(), 12)).toISOString());
      const dias = Math.max(1, Math.min(32000, Math.round((ends - hoy) / 86400_000)));
      const terms = `Paquete que compraste en ${fuenteTxt}, pasado a Bukéame el ${fechaPR(hoy)}. Se respetan los términos con que se vendió.`
        + (p.price_cents ? ` Pagaste ${dinero(p.price_cents)}.` : '');
      let r;
      for (let intento = 0; intento < 6; intento++) {
        await cx.query('SAVEPOINT paq');
        try {
          r = await cx.query(
            `INSERT INTO memberships (business_id, client_id, code, status, buyer_name, phone, email, source, name, price_cents,
                period_unit, period_count, visits_included, terms, starts_at, ends_at, visits_adjust, activated_at, mudanza_id, reminder_sent_at)
             VALUES ($1,$2,$3,'active',$4,$5,$6,'business',$7,0,'day',$8,$9,$10,now(),$11,$12,now(),$13,now()) RETURNING id`,
            [bid, cid, codigo('MEM'), cl.full_name, cl.phone, cl.email, p.name, dias, p.total, terms, ends, p.total - p.remaining, mid]);
          await cx.query('RELEASE SAVEPOINT paq');
          break;
        } catch (e) {
          await cx.query('ROLLBACK TO SAVEPOINT paq');
          if (e.code !== '23505') throw e;
        }
      }
      if (!r) continue;
      items.push(['membership', r.rows[0].id, 'created', { puso: { visits_adjust: p.total - p.remaining } }]);
      paquetes++;
    }

    // 8. Puntos de lealtad: se suman a lo que ya tenga; cada tantas visitas, un premio.
    let lealtad = 0;
    const req = plan.cxo.lealtadReq;
    for (const l of plan.lealtad) {
      const cid = cliente(l.clave);
      if (!cid || !req) continue;
      const ya = (await cx.query(`SELECT id, current_count, rewards_earned, rewards_redeemed FROM loyalty_progress WHERE business_id = $1 AND client_id = $2 FOR UPDATE`, [bid, cid])).rows[0];
      const total = (ya ? ya.current_count : 0) + l.visitas;
      const puso = { current_count: total % req, rewards_earned: (ya ? ya.rewards_earned : 0) + Math.floor(total / req), rewards_redeemed: ya ? ya.rewards_redeemed : 0 };
      if (ya) {
        await cx.query(`UPDATE loyalty_progress SET current_count = $2, rewards_earned = $3 WHERE id = $1`, [ya.id, puso.current_count, puso.rewards_earned]);
        items.push(['loyalty', ya.id, 'updated', { antes: { current_count: ya.current_count, rewards_earned: ya.rewards_earned }, puso }]);
      } else {
        const r = await cx.query(`INSERT INTO loyalty_progress (business_id, client_id, current_count, rewards_earned) VALUES ($1,$2,$3,$4) RETURNING id`,
          [bid, cid, puso.current_count, puso.rewards_earned]);
        items.push(['loyalty', r.rows[0].id, 'created', { puso }]);
      }
      lealtad++;
    }

    // Lo que hizo, para poder deshacerlo.
    for (let k = 0; k < items.length; k += 5000) {
      const lote = items.slice(k, k + 5000);
      await cx.query(
        `INSERT INTO mudanza_items (mudanza_id, entity, entity_id, action, prev)
         SELECT $1, x.e, x.i, x.a, x.p FROM unnest($2::text[], $3::uuid[], $4::text[], $5::jsonb[]) AS x(e, i, a, p)`,
        [mid, lote.map((x) => x[0]), lote.map((x) => x[1]), lote.map((x) => x[2]), lote.map((x) => (x[3] ? JSON.stringify(x[3]) : null))]);
    }

    const fuera = plan.archivos.reduce((s, x) => s + (x.a.quitado ? 0 : x.r.fuera.length), 0);
    return {
      plataforma: fuente, plataforma_nombre: fuenteTxt,
      totales: {
        clientes_nuevos: items.filter((x) => x[0] === 'client' && x[2] === 'created').length,
        clientes_completados: items.filter((x) => x[0] === 'client' && x[2] === 'updated').length,
        servicios: plan.serviciosNuevos.length, citas, choques: choques.length, historial,
        ventas, ventas_cents: ventasCents,
        repetidas: (hist.length - historial) + (plan.ventas.length - ventas),   // ya estaban de otra mudanza
        tarjetas, paquetes, lealtad, fuera, sin_recordatorio: sinRecordatorio,
      },
      choques: choques.slice(0, 100),
      codigos_nuevos: codigosNuevos.slice(0, 1000),
      recordatorios,
    };
  }

  // ---------- Deshacer ----------
  // Se borra lo que la mudanza creó y nadie ha usado; lo que ya tiene movimiento (una cita
  // cobrada, una tarjeta gastada, un cliente que reservó) se queda y se dice cuánto.
  app.post('/api/mudanza/:id/deshacer', ...PANEL, cuerpo, asyncH(async (req, res) => {
    const bid = req.business.id;
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const cx = await db.connect();
    let quedan;
    try {
      await cx.query('BEGIN');
      await cx.query(`SELECT pg_advisory_xact_lock(hashtext('mudanza:' || $1))`, [bid]);
      const m = (await cx.query(
        `SELECT * FROM mudanzas WHERE id = $1 AND business_id = $2 FOR UPDATE`, [req.params.id, bid])).rows[0];
      if (!m) { await cx.query('ROLLBACK'); return bad(res, 'Mudanza no encontrada', 404); }
      if (m.status !== 'done') { await cx.query('ROLLBACK'); return bad(res, 'Esa mudanza ya se deshizo.'); }
      if (new Date(m.done_at) < new Date(Date.now() - DESHACER_DIAS * 86400_000)) {
        await cx.query('ROLLBACK');
        return bad(res, `Ya pasaron los ${DESHACER_DIAS} días para deshacerla. Lo que no quieras, bórralo desde el panel.`);
      }
      // Al revés de como se hizo: si un cliente o sus puntos se tocaron dos veces, se vuelve paso por paso.
      const its = (await cx.query(`SELECT entity, entity_id, action, prev FROM mudanza_items WHERE mudanza_id = $1 ORDER BY id DESC`, [m.id])).rows;
      // La hora de la mudanza se compara en la base (JavaScript la corta a milisegundos).
      const hecha = m.id;
      const ids = (entity, action) => its.filter((x) => x.entity === entity && x.action === action).map((x) => x.entity_id);
      quedan = { citas: 0, clientes: 0, servicios: 0, tarjetas: 0, paquetes: 0, lealtad: 0 };

      const citas = ids('appointment', 'created');
      const borradas = await cx.query(
        `DELETE FROM appointments a WHERE a.id = ANY($1::uuid[]) AND a.business_id = $2 AND a.status = ANY($3)
            AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.appointment_id = a.id)
            AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.appointment_id = a.id)
          RETURNING a.id`, [citas, bid, ALIVE]);
      quedan.citas = citas.length - borradas.rowCount;
      await cx.query(`DELETE FROM client_import_history WHERE mudanza_id = $1 AND business_id = $2`, [m.id, bid]);
      await cx.query(`DELETE FROM imported_sales WHERE mudanza_id = $1 AND business_id = $2`, [m.id, bid]);

      for (const x of its.filter((y) => y.entity === 'gift_card')) {
        const r = await cx.query(
          `DELETE FROM gift_cards g WHERE g.id = $1 AND g.business_id = $2 AND g.balance_cents = $3
              AND NOT EXISTS (SELECT 1 FROM gift_card_redemptions gr WHERE gr.gift_card_id = g.id)
              AND NOT EXISTS (SELECT 1 FROM product_orders o WHERE o.gift_card_id = g.id)`, [x.entity_id, bid, x.prev.puso.balance_cents]);
        if (!r.rowCount) quedan.tarjetas++;
      }
      for (const x of its.filter((y) => y.entity === 'membership')) {
        const r = await cx.query(
          `DELETE FROM memberships ms WHERE ms.id = $1 AND ms.business_id = $2 AND ms.visits_adjust = $3
              AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.membership_id = ms.id)`, [x.entity_id, bid, x.prev.puso.visits_adjust]);
        if (!r.rowCount) quedan.paquetes++;
      }
      // Puntos: solo si nadie los movió (ni canjeó un premio) después de la mudanza.
      for (const x of its.filter((y) => y.entity === 'loyalty')) {
        const p = x.prev.puso;
        const canjes = p.rewards_redeemed == null ? 0 : p.rewards_redeemed;
        const r = x.action === 'created'
          ? await cx.query(`DELETE FROM loyalty_progress WHERE id = $1 AND business_id = $2 AND current_count = $3 AND rewards_earned = $4 AND rewards_redeemed = $5`, [x.entity_id, bid, p.current_count, p.rewards_earned, canjes])
          : await cx.query(`UPDATE loyalty_progress SET current_count = $6, rewards_earned = $7 WHERE id = $1 AND business_id = $2 AND current_count = $3 AND rewards_earned = $4 AND rewards_redeemed = $5`,
            [x.entity_id, bid, p.current_count, p.rewards_earned, canjes, x.prev.antes.current_count, x.prev.antes.rewards_earned]);
        if (!r.rowCount) quedan.lealtad++;
      }
      // Clientes que ya estaban: vuelve lo de antes, pero solo donde nadie lo cambió después.
      for (const x of its.filter((y) => y.entity === 'client' && y.action === 'updated')) {
        const actual = (await cx.query(`SELECT * FROM clients WHERE id = $1 AND business_id = $2 FOR UPDATE`, [x.entity_id, bid])).rows[0];
        if (!actual) continue;
        const cols = Object.keys(x.prev.puso).filter((c) => {
          const v = actual[c] instanceof Date ? actual[c].toISOString() : actual[c];
          const p = x.prev.puso[c];
          return v != null && p != null && (c === 'imported_last_visit_at' ? new Date(v).getTime() === new Date(p).getTime() : String(v) === String(p));
        });
        if (cols.length) await cx.query(`UPDATE clients SET ${cols.map((c, j) => `${c} = $${j + 3}`).join(', ')} WHERE id = $1 AND business_id = $2`,
          [x.entity_id, bid, ...cols.map((c) => x.prev.antes[c] ?? null)]);
      }
      // Clientes nuevos: se borran los que no tienen nada en Bukéame todavía y que el negocio
      // no tocó después de mudar (un nombre corregido, una nota, un bloqueo se respetan).
      const creados = ids('client', 'created');
      await cx.query('SAVEPOINT cl');
      try {
        const r = await cx.query(
          `DELETE FROM clients c WHERE c.id = ANY($1::uuid[]) AND c.business_id = $2 AND c.updated_at <= (SELECT done_at FROM mudanzas WHERE id = $3)
              AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.client_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM memberships ms WHERE ms.client_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM waitlist w WHERE w.client_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM rc_recipients rr WHERE rr.client_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM broadcast_recipients br WHERE br.client_id = c.id)
              -- los puntos que esta mudanza puso y nadie tocó ya se borraron arriba; si quedan, hubo movimiento
              AND NOT EXISTS (SELECT 1 FROM loyalty_progress lp WHERE lp.client_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.client_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.client_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM product_orders o WHERE o.client_id = c.id)
            RETURNING c.id`, [creados, bid, hecha]);
        await cx.query('RELEASE SAVEPOINT cl');
        quedan.clientes = creados.length - r.rowCount;
      } catch (e) {
        if (e.code !== '23503') throw e;
        await cx.query('ROLLBACK TO SAVEPOINT cl');   // otra tabla los usa: uno por uno
        quedan.clientes = 0;
        for (const id of creados) {
          await cx.query('SAVEPOINT uno');
          try {
            const r = await cx.query(`DELETE FROM clients WHERE id = $1 AND business_id = $2 AND updated_at <= (SELECT done_at FROM mudanzas WHERE id = $3)
                AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.client_id = $1)
                AND NOT EXISTS (SELECT 1 FROM memberships ms WHERE ms.client_id = $1)`, [id, bid, hecha]);
            await cx.query('RELEASE SAVEPOINT uno');
            if (!r.rowCount) quedan.clientes++;
          } catch (e2) {
            await cx.query('ROLLBACK TO SAVEPOINT uno');
            if (e2.code !== '23503') throw e2;
            quedan.clientes++;
          }
        }
      }
      const servicios = ids('service', 'created');
      const sb = await cx.query(
        `UPDATE services s SET deleted_at = now(), is_active = false
          WHERE s.id = ANY($1::uuid[]) AND s.business_id = $2 AND s.deleted_at IS NULL AND s.updated_at <= (SELECT done_at FROM mudanzas WHERE id = $3)
            AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.service_id = s.id)
          RETURNING s.id`, [servicios, bid, hecha]);
      quedan.servicios = servicios.length - sb.rowCount;
      await cx.query(
        `UPDATE mudanzas SET status = 'undone', undone_at = now(), updated_at = now(),
                summary = summary || jsonb_build_object('se_quedaron', $2::jsonb) WHERE id = $1`, [m.id, JSON.stringify(quedan)]);
      await cx.query('COMMIT');
    } catch (e) {
      await cx.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { cx.release(); }
    await audit(req, 'mudanza.undone', 'mudanza', req.params.id, quedan);
    res.json({ ok: true, se_quedaron: quedan });
  }));

  // ---------- Ventas de antes de Bukéame (para Contabilidad) ----------
  function rango(q) {
    const ok = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
    return { desde: ok(q.desde) ? q.desde : '1990-01-01', hasta: ok(q.hasta) ? q.hasta : '2100-01-01' };
  }
  app.get('/api/mudanza/ventas', ...PANEL, asyncH(async (req, res) => {
    const { desde, hasta } = rango(req.query);
    const { rows } = await db.query(
      `SELECT to_char(sold_at AT TIME ZONE 'America/Puerto_Rico', 'YYYY-MM') AS mes, count(*)::int AS ventas,
              sum(amount_cents)::bigint AS total_cents, sum(tip_cents)::bigint AS propinas_cents, sum(tax_cents)::bigint AS ivu_cents,
              array_agg(DISTINCT source) AS fuentes
         FROM imported_sales
        WHERE business_id = $1 AND (sold_at AT TIME ZONE 'America/Puerto_Rico')::date BETWEEN $2::date AND $3::date
        GROUP BY 1 ORDER BY 1 DESC`, [req.business.id, desde, hasta]);
    const fuentes = [...new Set(rows.flatMap((r) => r.fuentes || []))].map((f) => PLATAFORMAS[f] || f);
    res.json({
      meses: rows.map((r) => ({ mes: r.mes, ventas: r.ventas, total_cents: Number(r.total_cents), propinas_cents: Number(r.propinas_cents), ivu_cents: Number(r.ivu_cents) })),
      total_cents: rows.reduce((s, r) => s + Number(r.total_cents), 0), fuentes,
    });
  }));

  app.get('/api/mudanza/ventas.csv', ...PANEL, asyncH(async (req, res) => {
    const { desde, hasta } = rango(req.query);
    const { rows } = await db.query(
      `SELECT sold_at, source, description, client_name, amount_cents, tip_cents, tax_cents, method
         FROM imported_sales
        WHERE business_id = $1 AND (sold_at AT TIME ZONE 'America/Puerto_Rico')::date BETWEEN $2::date AND $3::date
        ORDER BY sold_at LIMIT 100000`, [req.business.id, desde, hasta]);
    // Una celda de texto que empieza con = + - @ la abriría Excel como fórmula: va con ' delante.
    const celda = (v) => {
      if (v && typeof v === 'object' && 'n' in v) return v.n;
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const num = (c) => ({ n: (Number(c || 0) / 100).toFixed(2) });   // los montos van como número (un reembolso es -10.00)
    const lineas = [['Fecha', 'Plataforma', 'Qué se vendió', 'Cliente', 'Total', 'Propina', 'IVU', 'Forma de pago'].join(',')];
    for (const r of rows) {
      lineas.push([new Date(r.sold_at).toLocaleDateString('en-CA', { timeZone: 'America/Puerto_Rico' }), PLATAFORMAS[r.source] || r.source,
        r.description, r.client_name, num(r.amount_cents), num(r.tip_cents), num(r.tax_cents), r.method].map(celda).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bukeame-ventas-antes-${desde}_a_${hasta}.csv"`);
    res.send('﻿' + lineas.join('\r\n'));
  }));

  // ---------- Admin: quién se mudó, de dónde y cómo le fue (sin datos de clientes) ----------
  app.get('/api/admin/mudanzas', authRequired, adminRequired, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `SELECT m.id, b.name AS negocio, b.slug, m.platform, m.status, m.created_at, m.done_at, m.undone_at,
              m.summary -> 'totales' AS totales, m.summary -> 'se_quedaron' AS se_quedaron
         FROM mudanzas m JOIN businesses b ON b.id = m.business_id
        WHERE m.status IN ('done','undone') ORDER BY m.created_at DESC LIMIT 100`);
    res.json({ mudanzas: rows.map((r) => ({ ...r, plataforma_nombre: PLATAFORMAS[r.platform] || r.platform })) });
  }));

  // Borradores de más de 24 horas: se borran las filas (traen datos de clientes). Y a los 30
  // días de mudar, el resumen se queda solo con los conteos (sin nombres ni códigos).
  async function limpiar() {
    await db.query(`UPDATE mudanzas SET status = 'expired', draft = NULL
                     WHERE status = 'draft' AND updated_at < now() - interval '24 hours'`);
    await db.query(`UPDATE mudanzas SET summary = summary - 'choques' - 'codigos_nuevos'
                     WHERE done_at < now() - interval '30 days' AND (summary ? 'choques' OR summary ? 'codigos_nuevos')`);
  }

  console.log('  ✓ módulo mudanza montado (pasar datos desde otra plataforma)');
  return { limpiar };
};
