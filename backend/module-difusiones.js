// ============================================================================
//  BUKEAME API — DIFUSIONES por WhatsApp (add-on 'broadcasts', $4.99/mes)
// ----------------------------------------------------------------------------
//  El negocio prepara un aviso (los espacios de la semana, una oferta, una noticia) y
//  le llega por WhatsApp a sus clientes ATENDIDOS que ACEPTARON recibir avisos.
//  Sale del número compartido de Bukéame (Evolution), el mismo de los recordatorios
//  de citas de todos los negocios. Si WhatsApp lo bloquea por spam, se caen esos
//  recordatorios; por eso todo va con frenos:
//  · Solo a quien aceptó y tiene al menos una cita completada. Si el sí lo marcó el
//    negocio, además tiene que haber prueba de que es su cliente de verdad: una cita
//    completada que reservó en línea, o un WhatsApp de una cita suya que sí le llegó.
//    Así un negocio no puede inventarse clientes y "permisos" con una lista comprada.
//  · Quien se da de baja con el enlace no vuelve a recibir. Ni el negocio ni nadie con
//    su teléfono lo puede volver a apuntar: solo esa persona, desde el enlace de baja.
//  · Sin enlaces ni dominios en el texto, ni en el nombre del cliente o del negocio.
//  · La PRIMERA difusión de cada negocio la aprueba Wifnix. Si una difusión trae muchas
//    bajas o números que no existen, el negocio queda en pausa hasta que Wifnix revise.
//  · Despacio: un mensaje a la vez con pausa, solo de día (hora de PR), turnándose entre
//    negocios, con tope diario para todo Bukéame, tope por teléfono entre todos los
//    negocios y días mínimos entre difusiones de un mismo negocio. Lo que no sale en
//    24 horas se cancela (los "espacios de esta semana" se ponen viejos).
//  · Si WhatsApp falla seguido, se para todo un rato. DIFUSIONES_PAUSA=1 lo apaga.
// ----------------------------------------------------------------------------
//  Negocio  GET /api/broadcasts · POST /api/broadcasts/preview · GET /api/broadcasts/espacios
//           POST /api/broadcasts · POST /api/broadcasts/:id/stop
//  Wifnix   GET /api/admin/broadcasts · POST /api/admin/broadcasts/:id/approve|reject
//           POST /api/admin/broadcasts/business/:id/unblock
//  Público  GET|POST /api/public/baja-wa/:token · POST .../todos · POST .../volver
//  server.js usa enviarSiguiente() en un ciclo y marca el permiso al reservar.
// ============================================================================

module.exports.mount = function (app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, isUuid, isEmail, audit, notify, codeLimiter, sendEmail, sendWhatsApp } = h;
  const APP_URL = (process.env.APP_URL || 'https://bukeame.com').replace(/\/+$/, '');

  // Frenos (se ajustan por .env y se leen al arrancar; un 0 vale: DIFUSION_TOPE_DIA=0 frena todo).
  const numEnv = (k, def) => { const v = process.env[k]; const n = Number(v); return v === undefined || v === '' || !Number.isFinite(n) ? def : n; };
  const MENSAJES_MES = numEnv('DIFUSION_MENSAJES_MES', 500);   // por negocio, mes de PR
  const TOPE_DIA = numEnv('DIFUSION_TOPE_DIA', 400);           // para todo Bukéame
  const DIAS_ENTRE = numEnv('DIFUSION_DIAS_ENTRE', 3);         // entre difusiones de un negocio
  const HORAS = String(process.env.DIFUSION_HORAS || '9-19').split('-').map(Number);   // de 9 a. m. a 7 p. m.
  const REVISAR_PRIMERA = process.env.DIFUSION_REVISAR_PRIMERA !== '0';
  const MAX_TEXTO = 600;

  const ADDON_OK = (alias) => `EXISTS (SELECT 1 FROM addons ad WHERE ad.business_id = ${alias}.id
      AND ad.code = 'broadcasts' AND ad.status = 'active'
      AND (ad.current_period_end IS NULL OR now() <= ad.current_period_end + interval '7 days'))`;
  // El sí que marcó el negocio solo vale con prueba de que la persona es su cliente.
  const PRUEBA_CLIENTE = (c) => `(EXISTS (SELECT 1 FROM appointments ap WHERE ap.client_id = ${c}.id AND ap.business_id = ${c}.business_id
                    AND ap.status = 'completed' AND ap.source = 'online')
      OR EXISTS (SELECT 1 FROM message_log ml JOIN appointments ma ON ma.id = ml.appointment_id
                  WHERE ml.business_id = ${c}.business_id AND ml.channel = 'whatsapp'
                    AND ml.recipient = ${c}.phone AND ml.status IN ('sent','delivered')
                    -- una cita que llegó con la mudanza no prueba nada: la puso el negocio desde un archivo
                    AND (to_jsonb(ma) ->> 'mudanza_id') IS NULL))`;
  // Quién puede recibir: aceptó, no se dio de baja después, no está bloqueado, ya fue
  // atendido alguna vez y, si el sí lo puso el negocio, hay prueba de que es su cliente.
  const PUEDE_RECIBIR = (c) => `(${c}.wa_promo_opt_in_at IS NOT NULL
      AND (${c}.wa_promo_opt_out_at IS NULL OR ${c}.wa_promo_opt_out_at < ${c}.wa_promo_opt_in_at)
      AND NOT ${c}.is_blocked AND ${c}.phone IS NOT NULL
      AND EXISTS (SELECT 1 FROM appointments ap WHERE ap.client_id = ${c}.id AND ap.business_id = ${c}.business_id
                    AND ap.status = 'completed')
      AND (${c}.wa_promo_source IS DISTINCT FROM 'negocio' OR ${PRUEBA_CLIENTE(c)}))`;
  const ATENDIDO = (c) => `(NOT ${c}.is_blocked AND ${c}.phone IS NOT NULL
      AND EXISTS (SELECT 1 FROM appointments ap WHERE ap.client_id = ${c}.id AND ap.business_id = ${c}.business_id
                    AND ap.status = 'completed'))`;
  const MES_PR = `date_trunc('month', now() AT TIME ZONE 'America/Puerto_Rico') AT TIME ZONE 'America/Puerto_Rico'`;
  const HOY_PR = `date_trunc('day', now() AT TIME ZONE 'America/Puerto_Rico') AT TIME ZONE 'America/Puerto_Rico'`;

  const waListo = () => !!(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY);
  const pausado = () => process.env.DIFUSIONES_PAUSA === '1';
  const adminRequired = (req, res, next) => (req.user && req.user.is_platform_admin ? next() : bad(res, 'Acceso restringido al administrador', 403));

  async function addonActivo(bid) {
    const { rows } = await db.query(`SELECT ${ADDON_OK('b')} AS ok FROM businesses b WHERE b.id = $1`, [bid]);
    return !!(rows[0] && rows[0].ok);
  }
  async function avisarWifnix(asunto, texto) {
    if (!sendEmail) return;
    let to = (process.env.ADMIN_ALERT_EMAIL || '').split(',').map(s => s.trim()).filter(isEmail);
    if (!to.length) to = (await db.query(`SELECT email FROM users WHERE is_platform_admin AND email IS NOT NULL`).catch(() => ({ rows: [] }))).rows.map(r => r.email);
    for (const addr of to) sendEmail(addr, asunto, texto).catch(e => console.error('difusiones aviso a Wifnix:', e.message));
  }

  // ── El texto ──────────────────────────────────────────────────────────────
  // Sin enlaces ni dominios: el único enlace lo pone Bukéame (reservar y darse de baja).
  // Cualquier "palabra.letras" cuenta como dominio (también con los puntos ．y 。), igual
  // que las direcciones IP y los dominios con acentos (xn--). Un punto sin espacio entre
  // dos palabras también cae aquí: el mensaje de error lo explica.
  const ENLACE = /(https?:|www[.．。]|xn--|\b\d{1,3}(?:[.．。]\d{1,3}){3}\b|[\p{L}\p{N}_-][.．。]\p{L}{2,})/iu;
  function revisarTexto(t) {
    const body = typeof t === 'string' ? t.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
    if (body.length < 10) return { error: 'Escribe el aviso (por lo menos una oración).' };
    if (body.length > MAX_TEXTO) return { error: `Tu aviso puede tener hasta ${MAX_TEXTO} letras y tiene ${body.length}. Acórtalo un poco.` };
    if (ENLACE.test(body)) return { error: 'Quita los enlaces, las páginas web y los emails del aviso: Bukéame le pone al final el enlace para reservar contigo. Si es un punto entre dos palabras, ponle un espacio después.' };
    return { body };
  }
  // El saludo solo lleva un nombre de verdad (letras); cualquier otra cosa se omite, para
  // que nadie cuele un enlace poniéndoselo de nombre al reservar.
  const primerNombre = (full) => {
    const n = String(full || '').trim().split(/\s+/)[0] || '';
    if (!/^[\p{L}'’-]{1,20}$/u.test(n)) return '';
    return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
  };
  const nombreNegocioMalo = (name) => ENLACE.test(String(name || ''));
  // El mensaje que le llega al cliente. Las respuestas a este número no las lee nadie,
  // así que no se le pide que conteste: la baja es un enlace.
  function mensaje(biz, nombre, body, token) {
    return `📣 *${biz.name}*\n${nombre ? `¡Hola, ${nombre}!\n` : ''}\n${body}\n\n`
      + `Reserva aquí: ${APP_URL}/negocio.html?slug=${encodeURIComponent(biz.slug)}\n\n`
      + `¿No quieres más avisos de ${biz.name}? Date de baja aquí: ${APP_URL}/baja.html?w=${token}`;
  }

  // ── Cuánto le queda al negocio ────────────────────────────────────────────
  async function estado(bid, cx = db) {
    const { rows } = await cx.query(
      `SELECT (SELECT count(*)::int FROM clients c WHERE c.business_id = $1 AND ${PUEDE_RECIBIR('c')}) AS aceptaron,
              (SELECT count(*)::int FROM clients c WHERE c.business_id = $1 AND ${ATENDIDO('c')}
                  AND NOT ${PUEDE_RECIBIR('c')} AND c.wa_promo_opt_out_at IS NULL) AS sin_aceptar,
              (SELECT count(*)::int FROM clients c WHERE c.business_id = $1 AND c.wa_promo_opt_out_at IS NOT NULL
                  AND (c.wa_promo_opt_in_at IS NULL OR c.wa_promo_opt_out_at >= c.wa_promo_opt_in_at)) AS de_baja,
              (SELECT count(*)::int FROM broadcast_recipients r WHERE r.business_id = $1
                  AND r.created_at >= ${MES_PR} AND r.status IN ('queued','sending','sent')) AS usados,
              (SELECT max(created_at) FROM broadcasts WHERE business_id = $1
                  AND NOT (status IN ('stopped','rejected') AND sent_count = 0)) AS ultima,
              b.broadcasts_approved_at AS aprobado, b.broadcasts_blocked_at AS pausa, b.broadcasts_block_reason AS pausa_razon
         FROM businesses b WHERE b.id = $1`,
      [bid]);
    const e = rows[0];
    const proxima = e.ultima ? new Date(new Date(e.ultima).getTime() + DIAS_ENTRE * 864e5) : null;
    return {
      opted_in: e.aceptaron, attended_not_opted: e.sin_aceptar, opted_out: e.de_baja,
      quota: { included: MENSAJES_MES, used: e.usados, left: Math.max(0, MENSAJES_MES - e.usados) },
      next_allowed_at: proxima && proxima > new Date() ? proxima : null,
      needs_review: REVISAR_PRIMERA && !e.aprobado,
      blocked: e.pausa ? { at: e.pausa, reason: e.pausa_razon } : null,
    };
  }

  // ==========================================================================
  //  NEGOCIO
  // ==========================================================================
  const HIST_COLS = `b.id, b.body, b.status, b.audience_count, b.capped, b.sent_count, b.failed_count, b.stop_reason, b.review_note,
                     b.created_at, b.started_at, b.finished_at,
                     (SELECT count(*)::int FROM broadcast_recipients r WHERE r.broadcast_id = b.id AND r.opted_out_at IS NOT NULL) AS opted_out,
                     (SELECT count(*)::int FROM broadcast_recipients r WHERE r.broadcast_id = b.id AND r.status IN ('queued','sending')) AS pending`;

  app.get('/api/broadcasts', authRequired, businessScope, asyncH(async (req, res) => {
    const bid = req.business.id;
    const [activo, e, hist] = await Promise.all([
      addonActivo(bid), estado(bid),
      db.query(`SELECT ${HIST_COLS} FROM broadcasts b WHERE business_id = $1 ORDER BY created_at DESC LIMIT 20`, [bid]),
    ]);
    res.json({
      addon_active: activo, whatsapp_ready: waListo(), paused: pausado(), ...e,
      broadcasts: hist.rows,
      rules: { max_length: MAX_TEXTO, min_days_between: DIAS_ENTRE, hours: HORAS },
    });
  }));

  // Cómo se ve el mensaje y a cuántos llega, sin enviar nada.
  app.post('/api/broadcasts/preview', authRequired, businessScope, asyncH(async (req, res) => {
    const t = revisarTexto((req.body || {}).body);
    if (t.error) return bad(res, t.error);
    const e = await estado(req.business.id);
    const llega = Math.min(e.opted_in, e.quota.left);
    const muestra = (await db.query(`SELECT full_name FROM clients c WHERE c.business_id = $1 AND ${PUEDE_RECIBIR('c')} ORDER BY c.last_visit_at DESC NULLS LAST LIMIT 1`, [req.business.id])).rows[0];
    res.json({
      message: mensaje(req.business, primerNombre(muestra ? muestra.full_name : 'María') || 'María', t.body, '…'),
      recipients: llega, capped: Math.max(0, e.opted_in - llega), quota: e.quota, next_allowed_at: e.next_allowed_at,
    });
  }));

  // Los espacios libres de los próximos 7 días, en texto listo para el aviso. Usa la
  // misma disponibilidad que la reserva (h.slotsDelDia en server.js). Días con nombre y
  // número (nunca "hoy" ni "mañana": el aviso puede salir horas después).
  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const horaCorta = (iso) => new Date(iso).toLocaleTimeString('es-PR', { timeZone: 'America/Puerto_Rico', hour: 'numeric', minute: '2-digit' });
  app.get('/api/broadcasts/espacios', authRequired, businessScope, asyncH(async (req, res) => {
    if (!h.slotsDelDia) return bad(res, 'No pudimos buscar tus espacios ahora mismo. Intenta en un rato.', 503);
    const sv = await db.query(
      `SELECT id, name FROM services WHERE business_id = $1 AND is_active AND deleted_at IS NULL
        ${isUuid(req.query.service_id) ? 'AND id = $2' : ''} ORDER BY sort_order, name LIMIT 1`,
      isUuid(req.query.service_id) ? [req.business.id, req.query.service_id] : [req.business.id]);
    if (!sv.rows[0]) return bad(res, 'Primero crea un servicio para poder buscar tus espacios.', 404);
    const lineas = [];
    let total = 0;
    for (let i = 0; i < 7; i++) {
      const dia = new Date(Date.now() + i * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Puerto_Rico' });
      const slots = (await h.slotsDelDia(req.business, sv.rows[0].id, dia)).filter(s => new Date(s) > new Date(Date.now() + 3 * 3600_000));
      if (!slots.length) continue;
      total += slots.length;
      const d = new Date(`${dia}T12:00:00-04:00`);
      const nombre = `${DIAS[d.getUTCDay()].charAt(0).toUpperCase() + DIAS[d.getUTCDay()].slice(1)} ${d.getUTCDate()}`;
      // Hasta 4 horarios repartidos en el día (el primero, el último y dos en medio), no
      // los 4 primeros seguidos: así se ve que hay espacio por la mañana y por la tarde.
      const n = slots.length;
      const elegidas = n <= 4 ? slots : [...new Set([0, Math.round((n - 1) / 3), Math.round(2 * (n - 1) / 3), n - 1])].map(k => slots[k]);
      const resto = n - elegidas.length;
      lineas.push(`${nombre}: ${elegidas.map(horaCorta).join(', ')}${resto > 0 ? ` y ${resto} ${resto === 1 ? 'horario más' : 'horarios más'}` : ''}`);
    }
    if (!lineas.length) return res.json({ text: '', total: 0, service: sv.rows[0].name, message: 'No tienes espacios libres en los próximos 7 días.' });
    const cab = `Tenemos espacios en los próximos días para ${sv.rows[0].name}:`;
    let text = `${cab}\n${lineas.join('\n')}`;
    while (text.length > MAX_TEXTO - 80 && lineas.length > 1) { lineas.pop(); text = `${cab}\n${lineas.join('\n')}`; }
    res.json({ text, total, service: sv.rows[0].name });
  }));

  app.post('/api/broadcasts', authRequired, businessScope, asyncH(async (req, res) => {
    const biz = req.business;
    if (!(await addonActivo(biz.id))) return bad(res, 'Activa Difusiones por WhatsApp en Mi cuenta para enviar avisos.', 403);
    if (!waListo() || pausado()) return bad(res, 'Los avisos por WhatsApp están en pausa por ahora. Intenta más tarde.', 503);
    if (nombreNegocioMalo(biz.name)) return bad(res, 'El nombre de tu negocio parece una página web. Cámbialo en Mi negocio para poder enviar avisos.', 409);
    const t = revisarTexto((req.body || {}).body);
    if (t.error) return bad(res, t.error);
    const cx = await db.connect();
    let out;
    try {
      await cx.query('BEGIN');
      // Una difusión a la vez por negocio, aunque toquen "Enviar" dos veces.
      await cx.query(`SELECT pg_advisory_xact_lock(hashtext('difusion:' || $1))`, [biz.id]);
      const e = await estado(biz.id, cx);
      if (e.blocked) {
        await cx.query('ROLLBACK');
        return bad(res, 'Tus avisos están en pausa mientras Bukéame revisa tu último aviso. Escríbenos por WhatsApp si tienes dudas.', 409);
      }
      if (e.next_allowed_at) {
        await cx.query('ROLLBACK');
        return bad(res, `Puedes enviar otro aviso desde el ${new Date(e.next_allowed_at).toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })}. Entre un aviso y otro hay que esperar ${DIAS_ENTRE} ${DIAS_ENTRE === 1 ? 'día' : 'días'} para que tus clientes no se cansen.`, 409);
      }
      if (!e.opted_in) { await cx.query('ROLLBACK'); return bad(res, 'Todavía ningún cliente ha aceptado recibir avisos. Cuando alguno acepte, ya puedes enviar tu primer aviso.', 409); }
      if (!e.quota.left) { await cx.query('ROLLBACK'); return bad(res, `Ya usaste los ${MENSAJES_MES} mensajes de este mes. El mes que viene tienes ${MENSAJES_MES} más.`, 409); }
      const revisar = e.needs_review;
      const b = await cx.query(
        `INSERT INTO broadcasts (business_id, body, created_by, status, queued_at)
         VALUES ($1,$2,$3,$4, CASE WHEN $4 = 'queued' THEN now() END) RETURNING id`,
        [biz.id, t.body, req.user && req.user.id ? req.user.id : null, revisar ? 'pending_review' : 'queued']);
      const id = b.rows[0].id;
      // Los más recientes primero: si no caben todos, que les llegue a los que vienen más.
      const ins = await cx.query(
        `INSERT INTO broadcast_recipients (broadcast_id, business_id, client_id, phone)
         SELECT $1, c.business_id, c.id, c.phone FROM clients c
          WHERE c.business_id = $2 AND ${PUEDE_RECIBIR('c')}
          ORDER BY c.last_visit_at DESC NULLS LAST, c.created_at DESC
          LIMIT $3`, [id, biz.id, e.quota.left]);
      await cx.query(`UPDATE broadcasts SET audience_count = $2, capped = $3 WHERE id = $1`,
        [id, ins.rowCount, Math.max(0, e.opted_in - ins.rowCount)]);
      await cx.query('COMMIT');
      out = { id, recipients: ins.rowCount, capped: Math.max(0, e.opted_in - ins.rowCount), status: revisar ? 'pending_review' : 'queued' };
    } catch (err) { await cx.query('ROLLBACK').catch(() => {}); throw err; }
    finally { cx.release(); }
    await audit(req, 'broadcast.create', 'broadcast', out.id, { recipients: out.recipients, review: out.status === 'pending_review' });
    if (out.status === 'pending_review')
      avisarWifnix(`Primer aviso por WhatsApp de ${biz.name}, por revisar`,
        `${biz.name} quiere enviar su primer aviso por WhatsApp a ${out.recipients} clientes.\n\n"${t.body}"\n\nRevísalo en ${APP_URL}/revisar-difusiones.html`);
    res.status(201).json(out);
  }));

  app.post('/api/broadcasts/:id/stop', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'No encontramos ese aviso.', 404);
    const { rows } = await db.query(
      `UPDATE broadcasts SET status = 'stopped', stop_reason = 'Lo detuviste', finished_at = now()
        WHERE id = $1 AND business_id = $2 AND status IN ('pending_review','queued','sending') RETURNING id`, [req.params.id, req.business.id]);
    if (!rows[0]) return bad(res, 'Ese aviso ya no se está enviando.', 409);
    await db.query(`UPDATE broadcast_recipients SET status = 'skipped' WHERE broadcast_id = $1 AND status = 'queued'`, [req.params.id]);
    await audit(req, 'broadcast.stop', 'broadcast', req.params.id);
    res.json({ ok: true });
  }));

  // ==========================================================================
  //  WIFNIX — aprobar la primera difusión de cada negocio y quitar pausas
  // ==========================================================================
  app.get('/api/admin/broadcasts', authRequired, adminRequired, asyncH(async (_req, res) => {
    const [pend, pausados, recientes] = await Promise.all([
      db.query(`SELECT b.id, b.body, b.audience_count, b.created_at, bz.name AS business_name, bz.slug,
                       (SELECT count(*)::int FROM broadcast_recipients r JOIN clients c ON c.id = r.client_id
                         WHERE r.broadcast_id = b.id AND c.wa_promo_source = 'negocio') AS por_negocio,
                       (SELECT count(*)::int FROM clients c WHERE c.business_id = b.business_id) AS clientes_total
                  FROM broadcasts b JOIN businesses bz ON bz.id = b.business_id
                 WHERE b.status = 'pending_review' ORDER BY b.created_at`),
      db.query(`SELECT id, name, slug, broadcasts_blocked_at, broadcasts_block_reason FROM businesses
                 WHERE broadcasts_blocked_at IS NOT NULL ORDER BY broadcasts_blocked_at DESC`),
      db.query(`SELECT ${HIST_COLS}, bz.name AS business_name FROM broadcasts b JOIN businesses bz ON bz.id = b.business_id
                 WHERE b.status <> 'pending_review' ORDER BY b.created_at DESC LIMIT 30`),
    ]);
    const hoy = await db.query(`SELECT count(*)::int n FROM broadcast_recipients WHERE status = 'sent' AND sent_at >= ${HOY_PR}`);
    res.json({ pending: pend.rows, blocked: pausados.rows, recent: recientes.rows,
      today: { sent: hoy.rows[0].n, cap: TOPE_DIA }, paused: pausado() || !waListo() });
  }));

  app.post('/api/admin/broadcasts/:id/approve', authRequired, adminRequired, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'No encontramos ese aviso.', 404);
    const { rows } = await db.query(
      `UPDATE broadcasts SET status = 'queued', queued_at = now(), reviewed_by = $2, reviewed_at = now()
        WHERE id = $1 AND status = 'pending_review' RETURNING business_id`, [req.params.id, req.user.id]);
    if (!rows[0]) return bad(res, 'Ese aviso ya no espera revisión.', 409);
    await db.query(`UPDATE businesses SET broadcasts_approved_at = COALESCE(broadcasts_approved_at, now()) WHERE id = $1`, [rows[0].business_id]);
    await notify(rows[0].business_id, 'system', 'Aprobamos tu aviso por WhatsApp',
      'Ya empezó a salir. Tus próximos avisos salen sin esperar revisión.', { broadcast_id: req.params.id }).catch(() => {});
    await audit(req, 'broadcast.approve', 'broadcast', req.params.id);
    res.json({ ok: true });
  }));

  app.post('/api/admin/broadcasts/:id/reject', authRequired, adminRequired, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'No encontramos ese aviso.', 404);
    const note = typeof (req.body || {}).note === 'string' ? req.body.note.trim().slice(0, 300) : '';
    if (note.length < 5) return bad(res, 'Escribe por qué no se aprueba: se lo enseñamos al negocio.');
    const { rows } = await db.query(
      `UPDATE broadcasts SET status = 'rejected', review_note = $3, reviewed_by = $2, reviewed_at = now(), finished_at = now()
        WHERE id = $1 AND status = 'pending_review' RETURNING business_id`, [req.params.id, req.user.id, note]);
    if (!rows[0]) return bad(res, 'Ese aviso ya no espera revisión.', 409);
    await db.query(`UPDATE broadcast_recipients SET status = 'skipped' WHERE broadcast_id = $1 AND status = 'queued'`, [req.params.id]);
    await notify(rows[0].business_id, 'system', 'Tu aviso por WhatsApp no se aprobó', note, { broadcast_id: req.params.id }).catch(() => {});
    await audit(req, 'broadcast.reject', 'broadcast', req.params.id, { note });
    res.json({ ok: true });
  }));

  app.post('/api/admin/broadcasts/business/:id/unblock', authRequired, adminRequired, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'No encontramos ese negocio.', 404);
    const { rowCount } = await db.query(
      `UPDATE businesses SET broadcasts_blocked_at = NULL, broadcasts_block_reason = NULL WHERE id = $1 AND broadcasts_blocked_at IS NOT NULL`, [req.params.id]);
    if (!rowCount) return bad(res, 'Ese negocio no tenía los avisos en pausa.', 409);
    await notify(req.params.id, 'system', 'Tus avisos por WhatsApp ya no están en pausa', 'Puedes volver a enviar avisos.').catch(() => {});
    await audit(req, 'broadcast.unblock', 'business', req.params.id);
    res.json({ ok: true });
  }));

  // Si una difusión trae muchas bajas o muchos números que no son de WhatsApp, el número
  // compartido se está "quemando": el negocio queda en pausa hasta que Wifnix lo revise.
  async function revisarSalud(broadcastId) {
    const { rows } = await db.query(
      `SELECT b.business_id, b.sent_count, bz.name, bz.broadcasts_blocked_at,
              (SELECT count(*)::int FROM broadcast_recipients r WHERE r.broadcast_id = b.id AND r.opted_out_at IS NOT NULL) AS bajas,
              (SELECT count(*)::int FROM broadcast_recipients r WHERE r.broadcast_id = b.id AND r.status = 'failed' AND r.error LIKE 'Evolution 4%') AS malos
         FROM broadcasts b JOIN businesses bz ON bz.id = b.business_id WHERE b.id = $1`, [broadcastId]);
    const s = rows[0];
    if (!s || s.broadcasts_blocked_at) return;
    let razon = null;
    if (s.bajas >= 5 && s.bajas >= 0.15 * Math.max(1, s.sent_count)) razon = `${s.bajas} de ${s.sent_count} personas se dieron de baja de un mismo aviso`;
    else if (s.malos >= 5 && s.malos >= 0.25 * Math.max(1, s.sent_count + s.malos)) razon = `${s.malos} números del aviso no tienen WhatsApp`;
    if (!razon) return;
    const u = await db.query(`UPDATE businesses SET broadcasts_blocked_at = now(), broadcasts_block_reason = $2 WHERE id = $1 AND broadcasts_blocked_at IS NULL`, [s.business_id, razon]);
    if (!u.rowCount) return;
    const paradas = await db.query(`UPDATE broadcasts SET status = 'stopped', stop_reason = 'En pausa mientras Bukéame lo revisa', finished_at = now()
                                     WHERE business_id = $1 AND status IN ('pending_review','queued','sending') RETURNING id`, [s.business_id]);
    for (const p of paradas.rows) await db.query(`UPDATE broadcast_recipients SET status = 'skipped' WHERE broadcast_id = $1 AND status = 'queued'`, [p.id]);
    await notify(s.business_id, 'system', 'Pusimos tus avisos por WhatsApp en pausa',
      `${razon}. Para cuidar el número de WhatsApp de todos, tus avisos quedan en pausa hasta que lo revisemos. Escríbenos si tienes dudas.`).catch(() => {});
    avisarWifnix(`Avisos de ${s.name} en pausa`, `Pusimos en pausa los avisos por WhatsApp de ${s.name}: ${razon}.\n\nRevísalo en ${APP_URL}/revisar-difusiones.html`);
  }

  // ==========================================================================
  //  PÚBLICO — darse de baja (y volver) con el enlace del mensaje
  // ==========================================================================
  async function porToken(token) {
    if (!isUuid(token)) return null;
    const { rows } = await db.query(
      `SELECT r.id, r.client_id, r.broadcast_id, r.phone, r.opted_out_at, b.name AS business_name,
              c.wa_promo_opt_in_at, c.wa_promo_opt_out_at
         FROM broadcast_recipients r JOIN businesses b ON b.id = r.business_id
         JOIN clients c ON c.id = r.client_id WHERE r.id = $1`, [token]);
    return rows[0] || null;
  }
  const deBaja = (r) => !!(r.wa_promo_opt_out_at && (!r.wa_promo_opt_in_at || r.wa_promo_opt_out_at >= r.wa_promo_opt_in_at));
  const NO_SIRVE = 'Ese enlace no funciona. Ábrelo completo desde el mensaje de WhatsApp.';
  app.get('/api/public/baja-wa/:token', codeLimiter, asyncH(async (req, res) => {
    const r = await porToken(req.params.token);
    if (!r) return bad(res, NO_SIRVE, 404);
    res.json({ business_name: r.business_name, unsubscribed: deBaja(r) });
  }));
  app.post('/api/public/baja-wa/:token', codeLimiter, asyncH(async (req, res) => {
    const r = await porToken(req.params.token);
    if (!r) return bad(res, NO_SIRVE, 404);
    await db.query(`UPDATE clients SET wa_promo_opt_out_at = now() WHERE id = $1`, [r.client_id]);
    await db.query(`UPDATE broadcast_recipients SET opted_out_at = COALESCE(opted_out_at, now()) WHERE id = $1`, [r.id]);
    // Si quedaba algo en la fila para esta persona (otra difusión), ya no sale.
    await db.query(`UPDATE broadcast_recipients SET status = 'skipped' WHERE client_id = $1 AND status = 'queued'`, [r.client_id]);
    await revisarSalud(r.broadcast_id).catch(e => console.error('difusiones salud:', e.message));
    res.json({ ok: true, business_name: r.business_name });
  }));
  // Tampoco de ningún otro negocio: se le da de baja en todos los negocios donde tenga
  // ese teléfono. Si luego acepta en uno (casilla o "volver"), vale solo para ese.
  app.post('/api/public/baja-wa/:token/todos', codeLimiter, asyncH(async (req, res) => {
    const r = await porToken(req.params.token);
    if (!r) return bad(res, NO_SIRVE, 404);
    const c = await db.query(
      `UPDATE clients SET wa_promo_opt_out_at = now()
        WHERE phone = $1 AND wa_promo_opt_in_at IS NOT NULL
          AND (wa_promo_opt_out_at IS NULL OR wa_promo_opt_out_at < wa_promo_opt_in_at) RETURNING id`, [r.phone]);
    await db.query(`UPDATE broadcast_recipients SET opted_out_at = COALESCE(opted_out_at, now()) WHERE id = $1`, [r.id]);
    await db.query(`UPDATE broadcast_recipients SET status = 'skipped' WHERE phone = $1 AND status = 'queued'`, [r.phone]);
    res.json({ ok: true, businesses: c.rowCount });
  }));
  // Se dio de baja por error: el enlace de su propio mensaje prueba que el teléfono es suyo.
  app.post('/api/public/baja-wa/:token/volver', codeLimiter, asyncH(async (req, res) => {
    const r = await porToken(req.params.token);
    if (!r) return bad(res, NO_SIRVE, 404);
    await db.query(`UPDATE clients SET wa_promo_opt_in_at = now(), wa_promo_source = 'baja' WHERE id = $1`, [r.client_id]);
    res.json({ ok: true, business_name: r.business_name });
  }));

  // ==========================================================================
  //  ENVÍO — un mensaje por vuelta; server.js lo llama con pausa
  // ==========================================================================
  let frenoHasta = 0;        // tras fallas seguidas de WhatsApp, no se envía hasta esta hora
  let fallasSeguidas = 0;
  function horaHabil() {
    const hPR = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Puerto_Rico', hour: 'numeric', hour12: false })) % 24;
    return hPR >= HORAS[0] && hPR < HORAS[1];
  }

  // Limpieza: lo que se quedó "enviando" más de 10 minutos (el proceso se cayó a mitad)
  // NO se reenvía, porque pudo haber llegado; y lo que no salió en 24 horas se cancela.
  async function limpiar() {
    const trabados = await db.query(
      `UPDATE broadcast_recipients SET status = 'failed', error = 'Se interrumpió el envío; no se reintenta para no duplicarlo'
        WHERE status = 'sending' AND (claimed_at IS NULL OR claimed_at < now() - interval '10 minutes') RETURNING broadcast_id`);
    for (const t of trabados.rows) {
      await db.query(`UPDATE broadcasts SET failed_count = failed_count + 1 WHERE id = $1`, [t.broadcast_id]);
      await cerrarSiTermino(t.broadcast_id);
    }
    const viejas = await db.query(
      `UPDATE broadcasts SET status = 'stopped', stop_reason = 'No alcanzó a salir completo en 24 horas', finished_at = now()
        WHERE status IN ('queued','sending') AND queued_at < now() - interval '24 hours' RETURNING id, business_id, sent_count`);
    for (const v of viejas.rows) {
      await db.query(`UPDATE broadcast_recipients SET status = 'skipped' WHERE broadcast_id = $1 AND status = 'queued'`, [v.id]);
      await notify(v.business_id, 'system', 'Tu aviso por WhatsApp no salió completo',
        `Salió para ${v.sent_count} ${v.sent_count === 1 ? 'cliente' : 'clientes'} y el resto no alcanzó a salir en 24 horas, así que lo cancelamos para que no llegue tarde.`,
        { broadcast_id: v.id }).catch(() => {});
    }
  }
  let ultimaLimpieza = 0;

  async function enviarSiguiente() {
    if (Date.now() - ultimaLimpieza > 5 * 60_000) { ultimaLimpieza = Date.now(); await limpiar(); }
    if (pausado() || !waListo() || !sendWhatsApp || Date.now() < frenoHasta || !horaHabil()) return { idle: true };
    const hoy = await db.query(`SELECT count(*)::int n FROM broadcast_recipients WHERE status = 'sent' AND sent_at >= ${HOY_PR}`);
    if (hoy.rows[0].n >= TOPE_DIA) return { idle: true, tope: true };
    // Se turnan los negocios: primero la difusión que hace más rato no envía.
    const pick = await db.query(
      `UPDATE broadcast_recipients SET status = 'sending', attempts = attempts + 1, claimed_at = now()
        WHERE id = (SELECT r.id FROM broadcast_recipients r JOIN broadcasts b ON b.id = r.broadcast_id
                     WHERE r.status = 'queued' AND b.status IN ('queued','sending')
                       AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= now())
                     ORDER BY b.last_sent_at NULLS FIRST, b.created_at, r.created_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED)
        RETURNING id, broadcast_id, business_id, client_id, phone, attempts`);
    const r = pick.rows[0];
    if (!r) return { idle: true };
    const ctx = await db.query(
      `SELECT b.id, b.body, b.status, bz.name, bz.slug, bz.broadcasts_blocked_at, ${ADDON_OK('bz')} AS addon_ok,
              c.full_name, ${PUEDE_RECIBIR('c')} AS puede,
              (SELECT count(*)::int FROM broadcast_recipients x WHERE x.phone = $3 AND x.status = 'sent' AND x.sent_at > now() - interval '1 day') AS hoy_tel,
              (SELECT count(*)::int FROM broadcast_recipients x WHERE x.phone = $3 AND x.status = 'sent' AND x.sent_at > now() - interval '7 days') AS semana_tel
         FROM broadcasts b JOIN businesses bz ON bz.id = b.business_id AND bz.deleted_at IS NULL
         JOIN clients c ON c.id = $2
        WHERE b.id = $1`, [r.broadcast_id, r.client_id, r.phone]);
    const x = ctx.rows[0];
    const saltar = async (motivo) => {
      await db.query(`UPDATE broadcast_recipients SET status = 'skipped', error = $2 WHERE id = $1`, [r.id, motivo]);
      await cerrarSiTermino(r.broadcast_id);
      return { skipped: true };
    };
    if (!x || !x.addon_ok || x.broadcasts_blocked_at || nombreNegocioMalo(x.name)) {
      // Sin add-on, en pausa o con un nombre que parece enlace: se para la difusión entera.
      await db.query(`UPDATE broadcast_recipients SET status = 'skipped' WHERE broadcast_id = $1 AND status IN ('queued','sending')`, [r.broadcast_id]);
      await db.query(`UPDATE broadcasts SET status = 'stopped', finished_at = now(),
                        stop_reason = $2 WHERE id = $1 AND status IN ('queued','sending')`,
        [r.broadcast_id, !x || !x.addon_ok ? 'Se detuvo porque Difusiones por WhatsApp no estaba activo' : 'En pausa mientras Bukéame lo revisa']);
      return { stopped: true };
    }
    if (x.status === 'stopped') return saltar('El aviso se detuvo');
    if (!x.puede) return saltar('Ya no acepta avisos');              // se dio de baja (o lo bloquearon) estando en la fila
    if (x.hoy_tel >= 1 || x.semana_tel >= 3) return saltar('Ya recibió un aviso por WhatsApp estos días');
    if (x.status === 'queued')
      await db.query(`UPDATE broadcasts SET status = 'sending', started_at = now() WHERE id = $1 AND status = 'queued'`, [r.broadcast_id]);
    try {
      const out = await sendWhatsApp(r.phone, mensaje(x, primerNombre(x.full_name), x.body, r.id));
      if (out && out.skipped) {   // WhatsApp no configurado: se queda en la fila
        await db.query(`UPDATE broadcast_recipients SET status = 'queued', attempts = attempts - 1 WHERE id = $1`, [r.id]);
        return { idle: true };
      }
      fallasSeguidas = 0;
      await db.query(`UPDATE broadcast_recipients SET status = 'sent', sent_at = now(), error = NULL WHERE id = $1`, [r.id]);
      await db.query(`UPDATE broadcasts SET sent_count = sent_count + 1, last_sent_at = now() WHERE id = $1`, [r.broadcast_id]);
    } catch (e) {
      const msg = String(e && e.message || e).slice(0, 300);
      const codigo = Number((/Evolution (\d{3})/.exec(msg) || [])[1]) || null;
      const sinRespuesta = (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) || /timeout|aborted/i.test(msg);
      const numeroMalo = codigo >= 400 && codigo < 500;
      // Sin respuesta: pudo haber llegado, así que no se repite. Número malo (4xx): no
      // tiene WhatsApp, repetir no sirve. Solo lo demás (5xx o la red) se reintenta, con
      // 10 minutos entre intentos y hasta 3 veces.
      const otraVez = !sinRespuesta && !numeroMalo && r.attempts < 3;
      if (!numeroMalo) fallasSeguidas++;
      await db.query(
        `UPDATE broadcast_recipients SET status = $2, error = $3, next_attempt_at = CASE WHEN $2 = 'queued' THEN now() + interval '10 minutes' END
          WHERE id = $1`, [r.id, otraVez ? 'queued' : 'failed', sinRespuesta ? 'WhatsApp no contestó a tiempo; no se reintenta para no duplicarlo' : msg]);
      if (!otraVez) await db.query(`UPDATE broadcasts SET failed_count = failed_count + 1, last_sent_at = now() WHERE id = $1`, [r.broadcast_id]);
      // Varias fallas seguidas = WhatsApp caído o con problemas: se para 15 minutos.
      if (fallasSeguidas >= 3) { frenoHasta = Date.now() + 15 * 60_000; fallasSeguidas = 0; console.error('difusiones: WhatsApp falló 3 veces seguidas; pausa de 15 min'); }
    }
    await cerrarSiTermino(r.broadcast_id);
    return { sent: true };
  }

  async function cerrarSiTermino(broadcastId) {
    const { rows } = await db.query(
      `UPDATE broadcasts SET status = 'sent', finished_at = now()
        WHERE id = $1 AND status IN ('queued','sending')
          AND NOT EXISTS (SELECT 1 FROM broadcast_recipients WHERE broadcast_id = $1 AND status IN ('queued','sending'))
        RETURNING business_id, sent_count, failed_count`, [broadcastId]);
    if (!rows[0]) return;
    const { sent_count: n, failed_count: f } = rows[0];
    await notify(rows[0].business_id, 'system', n ? 'Tu aviso por WhatsApp salió' : 'Tu aviso por WhatsApp no pudo salir',
      `Llegó a ${n} ${n === 1 ? 'cliente' : 'clientes'}${f ? ` (${f} no se ${f === 1 ? 'pudo' : 'pudieron'} enviar)` : ''}.`,
      { broadcast_id: broadcastId }).catch(() => {});
    await revisarSalud(broadcastId).catch(e => console.error('difusiones salud:', e.message));
  }

  console.log('  ✓ módulo difusiones montado (avisos por WhatsApp)');
  return { enviarSiguiente, limpiar };
};
