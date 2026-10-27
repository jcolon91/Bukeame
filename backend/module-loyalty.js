// ============================================================================
//  BUKEAME API — módulo B: FIDELIZACIÓN
//  Lealtad · Te-toca · Lista de espera (oferta con tiempo límite) · Control manual barbero
// ----------------------------------------------------------------------------
//  Se ENCHUFA al server.js base:
//    const loyalty = require('./module-loyalty');
//    loyalty.mount(app, { db, authRequired, businessScope, h });
//    loyalty.startWorkers({ db, h });   // cron de ofertas y te-toca
// ============================================================================

const crypto = require('crypto');

// Minutos que tiene el cliente para tomar un turno liberado (configurable por negocio,
// migración 34). Sin la migración, vale el default.
const DEFAULT_OFFER_MIN = 15;
async function offerMinutes(db, businessId) {
  try {
    const r = await db.query(`SELECT waitlist_offer_minutes AS m FROM businesses WHERE id = $1`, [businessId]);
    return r.rows[0]?.m || DEFAULT_OFFER_MIN;
  } catch (_e) { return DEFAULT_OFFER_MIN; }
}

module.exports.mount = function (app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, isStr, isUuid, isDate, normPhone, isPhone, audit, notify, confirmCode, bookingLimiter,
          codeLimiter, enqueueApptConfirm, alertOwner, fmtPR, oneLine, citaUrl } = h;

  const ALIVE = ['pending_deposit', 'confirmed'];

  // ¿el negocio compró el add-on 'loyalty'? (lealtad como add-on, migración 08)
  // Defensivo: si el enum addon_code aún no tiene 'loyalty', no revienta → false.
  async function hasLoyaltyAddon(businessId) {
    try {
      const { rows } = await db.query(
        `SELECT 1 FROM addons WHERE business_id = $1 AND code = 'loyalty' AND status = 'active'
           AND (current_period_end IS NULL OR now() <= current_period_end + interval '7 days')`,
        [businessId]);
      return !!rows[0];
    } catch (_e) {
      return false;
    }
  }

  // lealtad permitida = el plan tiene la feature 'loyalty' OR el negocio tiene el add-on
  async function loyaltyAllowed(businessId) {
    const eff = await db.query(
      `SELECT effective_plan FROM v_effective_plan WHERE business_id = $1`, [businessId]);
    const feat = await db.query(
      `SELECT (features->>'loyalty')::boolean ok FROM plans WHERE code = $1`,
      [eff.rows[0]?.effective_plan || 'free']);
    if (feat.rows[0]?.ok) return true;
    return await hasLoyaltyAddon(businessId);
  }

  // ==========================================================================
  //  PROGRAMA DE LEALTAD (lo paga el negocio; Bukeame solo cuenta)
  // ==========================================================================
  app.get('/api/loyalty', authRequired, businessScope, asyncH(async (req, res) => {
    // requiere feature de plan (Studio+), trial premium, O el add-on 'loyalty'
    const allowed = await loyaltyAllowed(req.business.id);

    const { rows } = await db.query(`SELECT * FROM loyalty_programs WHERE business_id = $1`, [req.business.id]);
    res.json({ allowed, program: rows[0] || null });
  }));

  app.put('/api/loyalty', authRequired, businessScope, asyncH(async (req, res) => {
    if (!(await loyaltyAllowed(req.business.id)))
      return bad(res, 'El programa de lealtad está en el plan Studio o superior, o como add-on', 403);

    const { is_active, visits_required, reward_text } = req.body || {};
    if (visits_required != null && (!Number.isInteger(visits_required) || visits_required < 2 || visits_required > 50))
      return bad(res, 'Las visitas requeridas deben estar entre 2 y 50');
    if (reward_text != null && !isStr(reward_text, 120)) return bad(res, 'Texto de premio inválido');

    const { rows } = await db.query(
      `INSERT INTO loyalty_programs (business_id, is_active, visits_required, reward_text)
       VALUES ($1, COALESCE($2,false), COALESCE($3,10), COALESCE($4,'Servicio gratis'))
       ON CONFLICT (business_id) DO UPDATE SET
         is_active = COALESCE($2, loyalty_programs.is_active),
         visits_required = COALESCE($3, loyalty_programs.visits_required),
         reward_text = COALESCE($4, loyalty_programs.reward_text)
       RETURNING *`,
      [req.business.id,
       typeof is_active === 'boolean' ? is_active : null,
       Number.isInteger(visits_required) ? visits_required : null,
       isStr(reward_text, 120) ? reward_text.trim() : null]);
    await audit(req, 'loyalty.update', 'loyalty', null, { is_active });
    res.json({ program: rows[0] });
  }));

  // ver progreso de un cliente (en el perfil del cliente)
  app.get('/api/clients/:id/loyalty', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const [prog, prg] = await Promise.all([
      db.query(`SELECT visits_required, reward_text, is_active FROM loyalty_programs WHERE business_id = $1`,
        [req.business.id]),
      db.query(`SELECT current_count, rewards_earned, rewards_redeemed FROM loyalty_progress
                 WHERE business_id = $1 AND client_id = $2`, [req.business.id, req.params.id]),
    ]);
    res.json({
      program: prog.rows[0] || null,
      progress: prg.rows[0] || { current_count: 0, rewards_earned: 0, rewards_redeemed: 0 },
    });
  }));

  // canjear un premio ganado (el barbero lo marca al dar el servicio gratis)
  app.post('/api/clients/:id/loyalty/redeem', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const { rows } = await db.query(
      `UPDATE loyalty_progress
          SET rewards_redeemed = rewards_redeemed + 1
        WHERE business_id = $1 AND client_id = $2 AND rewards_earned > rewards_redeemed
        RETURNING rewards_earned, rewards_redeemed`, [req.business.id, req.params.id]);
    if (!rows[0]) return bad(res, 'El cliente no tiene premios disponibles', 409);
    await audit(req, 'loyalty.redeem', 'client', req.params.id);
    res.json({ ok: true, ...rows[0] });
  }));

  // ==========================================================================
  //  RECORDATORIO "TE TOCA" — configuración
  // ==========================================================================
  app.get('/api/due-reminder', authRequired, businessScope, asyncH(async (req, res) => {
    res.json({
      enabled: req.business.due_reminder_enabled,
      days: req.business.due_reminder_days,
    });
  }));

  app.put('/api/due-reminder', authRequired, businessScope, asyncH(async (req, res) => {
    const eff = await db.query(`SELECT effective_plan FROM v_effective_plan WHERE business_id = $1`,
      [req.business.id]);
    const feat = await db.query(`SELECT (features->>'due_reminder')::boolean ok FROM plans WHERE code = $1`,
      [eff.rows[0]?.effective_plan || 'free']);
    if (!feat.rows[0]?.ok)
      return bad(res, 'El recordatorio "te toca" está en el plan Pro o superior', 403);

    const { enabled, days } = req.body || {};
    if (days != null && (!Number.isInteger(days) || days < 7 || days > 120))
      return bad(res, 'Los días deben estar entre 7 y 120');
    const { rows } = await db.query(
      `UPDATE businesses SET
         due_reminder_enabled = COALESCE($2, due_reminder_enabled),
         due_reminder_days = COALESCE($3, due_reminder_days)
        WHERE id = $1 RETURNING due_reminder_enabled, due_reminder_days`,
      [req.business.id, typeof enabled === 'boolean' ? enabled : null,
       Number.isInteger(days) ? days : null]);
    res.json({ enabled: rows[0].due_reminder_enabled, days: rows[0].due_reminder_days });
  }));

  // ==========================================================================
  //  LISTA DE ESPERA
  // ==========================================================================
  // pública: cliente entra a la lista (con o sin cita base protegida)
  app.post('/api/public/:slug/waitlist', bookingLimiter, asyncH(async (req, res) => {
    const { service_id, staff_id, date_from, date_to, full_name, phone, held_code } = req.body || {};
    if (!isStr(full_name, 120)) return bad(res, 'Tu nombre es requerido');
    if (!isPhone(phone)) return bad(res, 'Tu WhatsApp debe ser un número válido de PR/US (10 dígitos)');
    if (!isDate(date_from) || !isDate(date_to)) return bad(res, 'Fechas inválidas');
    if (date_to < date_from) return bad(res, 'Rango de fechas inválido');

    const b = await db.query(
      `SELECT b.id FROM businesses b
         JOIN subscriptions s ON s.business_id = b.id
         JOIN plans p ON p.code = s.plan_code
        WHERE b.slug = $1 AND b.deleted_at IS NULL
          AND (p.features->>'waitlist')::boolean = true`, [req.params.slug]);
    const biz = b.rows[0];
    if (!biz) return bad(res, 'Este negocio no tiene lista de espera activa', 404);

    const phoneN = normPhone(phone);
    // cliente del CRM
    const cl = await db.query(
      `INSERT INTO clients (business_id, full_name, phone)
       VALUES ($1,$2,$3) ON CONFLICT (business_id, phone)
       DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`,
      [biz.id, full_name.trim(), phoneN]);

    // ABUSE: tope de entradas activas en lista de espera por cliente (teléfono).
    // Sin él, un actor podía apilar cientos de filas basura en la lista y el CRM.
    const wcap = await db.query(
      `SELECT count(*)::int n FROM waitlist WHERE business_id = $1 AND client_id = $2 AND status = 'waiting'`,
      [biz.id, cl.rows[0].id]);
    if (wcap.rows[0].n >= 5)
      return bad(res, 'Ya estás varias veces en la lista de espera. Espera a que te avisemos.', 429);

    // ¿tiene una cita base que proteger? (held_code)
    let heldId = null;
    if (isStr(held_code, 40)) {
      const held = await db.query(
        `SELECT id FROM appointments WHERE business_id = $1 AND confirmation_code = $2
           AND client_id = $3 AND status = ANY($4)`,
        [biz.id, held_code.trim().toUpperCase(), cl.rows[0].id, ALIVE]);
      heldId = held.rows[0]?.id || null;
    }

    // posición FIFO
    const pos = await db.query(
      `SELECT COALESCE(max(position),0)+1 n FROM waitlist
        WHERE business_id = $1 AND status = 'waiting'`, [biz.id]);

    const { rows } = await db.query(
      `INSERT INTO waitlist (business_id, client_id, service_id, staff_id,
          date_from, date_to, held_appointment_id, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, position`,
      [biz.id, cl.rows[0].id,
       isUuid(service_id) ? service_id : null,
       isUuid(staff_id) ? staff_id : null,
       date_from, date_to, heldId, pos.rows[0].n]);

    res.status(201).json({
      waitlist_id: rows[0].id,
      position: rows[0].position,
      protected: !!heldId,
      note: heldId
        ? 'Tu cita actual queda protegida. Si se libera un cupo mejor, te avisamos por WhatsApp.'
        : 'Estás en lista. Si se libera un cupo, te avisamos por WhatsApp.',
    });
  }));

  // negocio: cuántos minutos tiene el cliente para tomar un turno que se liberó
  app.put('/api/waitlist/settings', authRequired, businessScope, asyncH(async (req, res) => {
    const m = Number(req.body?.offer_minutes);
    if (!Number.isInteger(m) || m < 5 || m > 120) return bad(res, 'Escoge entre 5 y 120 minutos');
    try {
      await db.query(`UPDATE businesses SET waitlist_offer_minutes = $1 WHERE id = $2`, [m, req.business.id]);
    } catch (e) {
      console.error('waitlist settings (¿falta la migración 34?):', e.message);
      return bad(res, 'Esta opción todavía no está disponible. Intenta más tarde.', 409);
    }
    res.json({ ok: true, offer_minutes: m });
  }));

  // negocio: ver lista de espera del día / rango (panel)
  app.get('/api/waitlist', authRequired, businessScope, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `SELECT w.id, w.date_from, w.date_to, w.status, w.offer_state, w.offer_expires_at, w.position,
              c.full_name, c.phone, c.no_show_count,
              s.name AS service_name, s.duration_min, s.price_cents,
              st.display_name AS staff_name,
              w.held_appointment_id IS NOT NULL AS has_held
         FROM waitlist w
         JOIN clients c ON c.id = w.client_id
         LEFT JOIN services s ON s.id = w.service_id
         LEFT JOIN staff st ON st.id = w.staff_id
        WHERE w.business_id = $1 AND w.status IN ('waiting','offered')
        ORDER BY w.position`, [req.business.id]);
    res.json({ waitlist: rows, offer_minutes: await offerMinutes(db, req.business.id) });
  }));

  app.delete('/api/waitlist/:id', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    // Si tenía una oferta abierta, se cierra: quien salió de la lista ya no la puede tomar.
    await db.query(`UPDATE waitlist SET status = 'expired',
                           offer_state = CASE WHEN offer_state = 'offered' THEN 'declined'::waitlist_offer_st ELSE offer_state END
                     WHERE id = $1 AND business_id = $2`, [req.params.id, req.business.id]);
    res.json({ ok: true });
  }));

  // ==========================================================================
  //  OFERTA DE LA LISTA DE ESPERA — la toma el cliente desde oferta.html?id=
  // --------------------------------------------------------------------------
  //  El enlace del WhatsApp lleva el id de su fila en waitlist (uuid aleatorio): solo
  //  lo tienen el cliente y el negocio. Antes el mensaje decía "responde SÍ" y nadie
  //  leía esas respuestas, así que ninguna oferta se podía aceptar.
  // ==========================================================================
  // El turno nuevo pide depósito si la cita liberada lo pedía. Si el cliente tenía una
  // cita protegida con depósito PAGADO, ese depósito se muda al turno nuevo y la vieja
  // se cancela. Si hay que pagar depósito nuevo, la vieja NO se toca (si no paga en 30
  // min, perdería las dos); él la cancela si quiere.
  async function offerView(id) {
    const { rows } = await db.query(
      `SELECT w.id, w.offer_state, w.status, w.offer_expires_at,
              a.starts_at, a.service_name, a.deposit_cents, st.display_name AS staff_name,
              b.name AS business_name, b.slug,
              ha.id AS held_id, ha.starts_at AS held_starts_at, ha.service_name AS held_service,
              (SELECT COALESCE(sum(p.amount_cents),0)::int FROM payments p
                WHERE p.appointment_id = ha.id AND p.kind = 'deposit' AND p.status = 'paid') AS held_paid
         FROM waitlist w
         JOIN businesses b ON b.id = w.business_id
         LEFT JOIN appointments a ON a.id = w.offered_appointment_id
         LEFT JOIN staff st ON st.id = a.staff_id
         LEFT JOIN appointments ha ON ha.id = w.held_appointment_id AND ha.status = ANY($2)
        WHERE w.id = $1`, [id, ALIVE]);
    return rows[0] || null;
  }

  app.get('/api/public/waitlist-offers/:id', codeLimiter, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'Oferta no encontrada', 404);
    const o = await offerView(req.params.id);
    if (!o) return bad(res, 'Oferta no encontrada', 404);
    const live = o.offer_state === 'offered' && o.status === 'waiting' && new Date(o.offer_expires_at) > new Date();
    // expired = venció y sigue en la lista; removed = ya no está en la lista (lo sacaron
    // o el negocio le asignó otro turno a mano).
    const out = {
      state: live ? 'offered'
        : o.offer_state === 'accepted' ? 'accepted'
        : o.status === 'waiting' ? 'expired' : 'removed',
      business_name: o.business_name, slug: o.slug,
      starts_at: o.starts_at, service_name: o.service_name, staff_name: o.staff_name,
      expires_at: live ? o.offer_expires_at : null,
    };
    if (out.state === 'accepted') {
      // tras aceptar, offered_appointment_id apunta al turno nuevo
      const a = await db.query(
        `SELECT confirmation_code FROM appointments a JOIN waitlist w ON w.offered_appointment_id = a.id WHERE w.id = $1`,
        [req.params.id]);
      out.confirmation_code = a.rows[0]?.confirmation_code || null;
    }
    if (live) {
      out.deposit_cents = o.held_paid > 0 ? 0 : (o.deposit_cents || 0);
      if (o.held_id) out.held = {
        starts_at: o.held_starts_at, service_name: o.held_service,
        will_cancel: !(o.deposit_cents > 0) || o.held_paid > 0,
      };
    }
    res.json({ offer: out });
  }));

  app.post('/api/public/waitlist-offers/:id/accept', codeLimiter, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'Oferta no encontrada', 404);
    const client = await db.connect();
    let appt, w, slot, held = null, freedHeld = null;
    try {
      await client.query('BEGIN');
      w = (await client.query(`SELECT * FROM waitlist WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!w) { await client.query('ROLLBACK'); return bad(res, 'Oferta no encontrada', 404); }
      if (w.status !== 'waiting' || w.offer_state !== 'offered' || !(new Date(w.offer_expires_at) > new Date())) {
        await client.query('ROLLBACK');
        return bad(res, w.status === 'waiting'
          ? 'Esta oferta ya venció. Sigues en la lista de espera.'
          : 'Esta oferta ya no está disponible.', 409);
      }
      slot = (await client.query(`SELECT * FROM appointments WHERE id = $1`, [w.offered_appointment_id])).rows[0];
      const blocked = slot && (await client.query(
        `SELECT 1 FROM time_blocks WHERE business_id = $1 AND (staff_id IS NULL OR staff_id = $2)
            AND starts_at < $4 AND ends_at > $3 AND COALESCE(reason,'') <> '__OPEN_SLOT__' LIMIT 1`,
        [slot.business_id, slot.staff_id, slot.starts_at, slot.ends_at])).rows[0];
      if (!slot || blocked) {
        await client.query(`UPDATE waitlist SET offer_state = 'expired' WHERE id = $1`, [w.id]);
        await client.query('COMMIT');
        return bad(res, 'Ese turno ya no está disponible. Sigues en la lista de espera.', 409);
      }

      held = w.held_appointment_id ? (await client.query(
        `SELECT a.id, (SELECT COALESCE(sum(p.amount_cents),0)::int FROM payments p
                        WHERE p.appointment_id = a.id AND p.kind = 'deposit' AND p.status = 'paid') AS paid
           FROM appointments a WHERE a.id = $1 AND a.status = ANY($2) FOR UPDATE`,
        [w.held_appointment_id, ALIVE])).rows[0] : null;
      const needDeposit = (slot.deposit_cents || 0) > 0 && !(held && held.paid > 0);
      const depositCents = held && held.paid > 0 ? held.paid : (needDeposit ? slot.deposit_cents : 0);

      await client.query('SAVEPOINT ins');
      try {
        appt = (await client.query(
          `INSERT INTO appointments (business_id, client_id, staff_id, service_id, service_name, service_ids,
              duration_min, price_cents, deposit_cents, starts_at, ends_at, status, source, confirmation_code)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'online',$13) RETURNING *`,
          [w.business_id, w.client_id, slot.staff_id, slot.service_id, slot.service_name,
           JSON.stringify(slot.service_ids || []), slot.duration_min, slot.price_cents, depositCents,
           slot.starts_at, slot.ends_at, needDeposit ? 'pending_deposit' : 'confirmed',
           confirmCode('ESP', slot.starts_at)])).rows[0];
      } catch (e) {
        if (e.code !== '23P01') throw e;
        await client.query('ROLLBACK TO SAVEPOINT ins');
        await client.query(`UPDATE waitlist SET offer_state = 'expired' WHERE id = $1`, [w.id]);
        await client.query('COMMIT');
        return bad(res, 'Ese turno ya lo tomó otra persona. Sigues en la lista de espera.', 409);
      }

      if (needDeposit)
        await client.query(
          `INSERT INTO payments (business_id, appointment_id, client_id, kind, method, amount_cents)
           VALUES ($1,$2,$3,'deposit','ath_movil',$4)`, [w.business_id, appt.id, w.client_id, depositCents]);
      if (held && !needDeposit) {
        // el depósito ya pagado se muda al turno nuevo; la cita vieja queda libre
        await client.query(
          `UPDATE payments SET appointment_id = $2
            WHERE appointment_id = $1 AND kind = 'deposit' AND status = 'paid'`, [held.id, appt.id]);
        freedHeld = (await client.query(
          `UPDATE appointments SET status = 'cancelled_client', cancelled_at = now(),
                  cancel_reason = 'Tomó un turno de la lista de espera'
            WHERE id = $1 RETURNING starts_at`, [held.id])).rows[0];
      }
      await client.query(
        `UPDATE waitlist SET status = 'booked', offer_state = 'accepted', offered_appointment_id = $2 WHERE id = $1`,
        [w.id, appt.id]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }

    // Después del COMMIT: el cliente recibe su confirmación (o el enlace para pagar el
    // depósito) y el dueño se entera por in-app + WhatsApp/email.
    await enqueueApptConfirm(w.business_id, appt.id);
    const who = (await db.query(`SELECT full_name FROM clients WHERE id = $1`, [w.client_id])).rows[0]?.full_name || 'Un cliente';
    const detail = oneLine(`${who} tomó ${appt.service_name} · ${fmtPR(appt.starts_at)}`
      + (appt.status === 'pending_deposit' ? ' · pendiente de depósito' : '')
      + (freedHeld ? ` · soltó su cita del ${fmtPR(freedHeld.starts_at)}` : '')).slice(0, 200);
    await alertOwner(w.business_id, appt.id, {
      type: 'waitlist', title: 'Turno tomado de la lista de espera', body: detail, template: 'owner_waitlist',
      wa: `*Bukéame* — Turno tomado de la lista de espera\n\n${detail}\n\nMíralo en tu panel de Bukéame: Agenda.`,
    });
    res.status(201).json({
      ok: true,
      appointment: { confirmation_code: appt.confirmation_code, status: appt.status, starts_at: appt.starts_at,
                     service_name: appt.service_name, deposit_cents: appt.deposit_cents },
      cita_url: citaUrl(appt.confirmation_code),
      held_kept: !!held && !freedHeld,
    });
  }));

  // ==========================================================================
  //  CONTROL MANUAL DEL BARBERO — abrir cupo (visible para todos o asignar)
  // ==========================================================================
  // (a) abrir cupo VISIBLE para todos = quitar un bloqueo / extender horario ese día.
  //     Creamos un time_block "negativo" no aplica; en su lugar, el barbero crea
  //     disponibilidad puntual. Modelamos como una cita-hueco reservable: mejor,
  //     simplemente permitimos crear la cita manual (ya existe) o abrir el slot.
  //     Para "visible para todos" basta con que el horario lo permita; si es fuera
  //     de horario, registramos una EXCEPCIÓN de apertura.
  app.post('/api/slots/open', authRequired, businessScope, asyncH(async (req, res) => {
    const { staff_id, start_iso, duration_min, visibility, waitlist_id } = req.body || {};
    if (!isUuid(staff_id)) return bad(res, 'Profesional requerido');
    const starts = new Date(start_iso || '');
    if (isNaN(starts)) return bad(res, 'Horario inválido');
    if (!Number.isInteger(duration_min) || duration_min < 5 || duration_min > 480)
      return bad(res, 'Duración inválida');

    const own = await db.query(`SELECT 1 FROM staff WHERE id = $1 AND business_id = $2 AND is_active`,
      [staff_id, req.business.id]);
    if (!own.rows[0]) return bad(res, 'Profesional no encontrado', 404);

    const ends = new Date(starts.getTime() + duration_min * 60_000);

    // ── VISIBILIDAD: "assign" = asignar directo a un cliente de la lista de espera ──
    if (visibility === 'assign') {
      if (!isUuid(waitlist_id)) return bad(res, 'Falta el cliente de la lista de espera');
      const w = await db.query(
        `SELECT w.*, c.full_name, c.phone, s.name svc, s.duration_min sdur, s.price_cents sprice, s.id sid
           FROM waitlist w JOIN clients c ON c.id = w.client_id
           LEFT JOIN services s ON s.id = w.service_id
          WHERE w.id = $1 AND w.business_id = $2 AND w.status IN ('waiting','offered')`,
        [waitlist_id, req.business.id]);
      if (!w.rows[0]) return bad(res, 'Cliente de lista de espera no encontrado', 404);
      const wl = w.rows[0];

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        // HUMANO MANDA: cancelar cualquier oferta automática pendiente de este cliente
        await client.query(
          `UPDATE waitlist SET offer_state = 'declined'
            WHERE business_id = $1 AND client_id = $2 AND offer_state = 'offered' AND id <> $3`,
          [req.business.id, wl.client_id, waitlist_id]);

        const code = confirmCode('MAN', starts);
        let appt;
        try {
          const r = await client.query(
            `INSERT INTO appointments (business_id, client_id, staff_id, service_id, service_name,
                duration_min, price_cents, deposit_cents, starts_at, ends_at, status, source, confirmation_code)
             VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,'confirmed','manual',$10) RETURNING *`,
            [req.business.id, wl.client_id, staff_id, wl.sid || null,
             wl.svc || 'Servicio', wl.sdur || duration_min, wl.sprice || 0,
             starts, ends, code]);
          appt = r.rows[0];
        } catch (e) {
          if (e.code === '23P01') { await client.query('ROLLBACK'); return bad(res, 'Ese profesional ya tiene cita en ese horario', 409); }
          throw e;
        }

        // sacar de la lista de espera (ya fue atendido) y soltar su cita base si la tenía
        await client.query(`UPDATE waitlist SET status = 'booked', offered_appointment_id = $2 WHERE id = $1`,
          [waitlist_id, appt.id]);

        await client.query('COMMIT');

        // avisar al cliente por WhatsApp (queue)
        await db.query(
          `INSERT INTO message_log (business_id, appointment_id, channel, recipient, template)
           VALUES ($1,$2,'whatsapp',$3,'manual_assign')`, [req.business.id, appt.id, wl.phone]);

        await audit(req, 'slot.assign', 'appointment', appt.id, { waitlist_id });
        return res.status(201).json({ appointment: appt, assigned_to: wl.full_name });
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    }

    // ── VISIBILIDAD: "public" = abrir el cupo para que cualquiera lo reserve online ──
    // Si es fuera de horario, registramos una apertura puntual (staff_hours extra ese día
    // no aplica porque es por fecha; usamos un marcador en time_blocks con reason especial).
    // Mejor: creamos una "cita-placeholder abierta" no; en su lugar dejamos constancia y
    // el motor de disponibilidad considerará este rango como abierto vía tabla de aperturas.
    if (visibility === 'public') {
      // registrar apertura puntual
      await db.query(
        `INSERT INTO time_blocks (business_id, staff_id, starts_at, ends_at, reason)
         VALUES ($1,$2,$3,$4,'__OPEN_SLOT__')`,
        [req.business.id, staff_id, starts, ends]);
      // NOTA: el motor de disponibilidad trata reason='__OPEN_SLOT__' como apertura,
      // no como bloqueo (ver parche en server base).
      await audit(req, 'slot.open_public', 'staff', staff_id, { start_iso, duration_min });
      return res.status(201).json({
        ok: true, visibility: 'public',
        note: 'Cupo abierto. Aparecerá disponible para reserva online en ese horario.',
      });
    }

    return bad(res, 'Indica visibility: "public" o "assign"');
  }));

  console.log('  ✓ módulo fidelización montado (lealtad, te-toca, lista espera, control manual)');
};

// ============================================================================
//  WORKERS — ofertas de lista de espera (tiempo límite por negocio) y recordatorio te-toca
// ============================================================================
module.exports.startWorkers = function (ctx) {
  const { db } = ctx;
  const ALIVE = ['pending_deposit', 'confirmed'];

  // Ofrece UN cupo liberado (la cita cancelada: mismo profesional, servicio y hora) al
  // primero de la fila que le sirva. Solo si es a futuro con tiempo para tomarlo, si
  // sigue libre (sin cita viva ni bloqueo del negocio encima), el profesional sigue
  // activo y el plan incluye lista de espera. No se le ofrece a quien lo canceló, a
  // quien ya tiene otra oferta abierta, ni a quien ya se le ofreció este mismo cupo.
  async function offerSlot(slot) {
    const startMs = new Date(slot.starts_at).getTime();
    const minutes = await offerMinutes(db, slot.business_id);
    // Mínimo fijo de 25 min: con poco margen el tiempo de la oferta se acorta (vence 15 min
    // antes de la cita) en vez de no ofrecer el turno.
    if (startMs < Date.now() + 25 * 60_000) return;
    const ok = await db.query(
      `SELECT
         EXISTS (SELECT 1 FROM businesses b JOIN subscriptions s ON s.business_id = b.id
                   JOIN plans p ON p.code = s.plan_code
                  WHERE b.id = $1 AND b.deleted_at IS NULL AND (p.features->>'waitlist')::boolean = true)
         AND EXISTS (SELECT 1 FROM staff WHERE id = $2 AND is_active)
         AND NOT EXISTS (SELECT 1 FROM appointments x WHERE x.staff_id = $2 AND x.status = ANY($5)
                           AND x.starts_at < $4 AND x.ends_at > $3)
         AND NOT EXISTS (SELECT 1 FROM time_blocks tb WHERE tb.business_id = $1
                           AND (tb.staff_id IS NULL OR tb.staff_id = $2)
                           AND tb.starts_at < $4 AND tb.ends_at > $3
                           AND COALESCE(tb.reason,'') <> '__OPEN_SLOT__') AS ok`,
      [slot.business_id, slot.staff_id, slot.starts_at, slot.ends_at, ALIVE]);
    if (!ok.rows[0].ok) return;

    const slotDate = new Date(slot.starts_at).toLocaleDateString('en-CA', { timeZone: 'America/Puerto_Rico' });
    const cand = await db.query(
      `SELECT w.id, c.phone
         FROM waitlist w JOIN clients c ON c.id = w.client_id
        WHERE w.business_id = $1 AND w.status = 'waiting' AND w.offer_state <> 'offered'
          AND $2::date BETWEEN w.date_from AND w.date_to
          AND (w.service_id IS NULL OR w.service_id = $3)
          AND (w.staff_id IS NULL OR w.staff_id = $4)
          AND w.offered_appointment_id IS DISTINCT FROM $5
          AND w.client_id <> $6
          AND c.is_blocked = false
          AND NOT EXISTS (SELECT 1 FROM waitlist w2 WHERE w2.business_id = w.business_id
                            AND w2.client_id = w.client_id AND w2.offer_state = 'offered')
        ORDER BY w.position LIMIT 1`,
      [slot.business_id, slotDate, slot.service_id, slot.staff_id, slot.id, slot.client_id]);
    const w = cand.rows[0];
    if (!w) return;
    // Los minutos del negocio para tomarlo, sin pasarse de 15 min antes de la cita.
    const expires = new Date(Math.min(Date.now() + minutes * 60_000, startMs - 15 * 60_000));
    const upd = await db.query(
      `UPDATE waitlist SET offer_state = 'offered', offered_appointment_id = $2,
              offered_at = now(), offer_expires_at = $3
        WHERE id = $1 AND offer_state <> 'offered'`, [w.id, slot.id, expires]);
    if (!upd.rowCount) return;
    // El WhatsApp lleva el enlace oferta.html?id=<waitlist.id> (lo arma dispatchMessages).
    await db.query(
      `INSERT INTO message_log (business_id, appointment_id, channel, recipient, template)
       VALUES ($1,$2,'whatsapp',$3,'waitlist_offer')`, [slot.business_id, slot.id, w.phone]);
  }

  const SLOT_COLS = `a.id, a.business_id, a.staff_id, a.service_id, a.client_id, a.starts_at, a.ends_at`;

  // -- (1) Ofertas vencidas → pasan al siguiente de la fila ----------------------
  async function rotateOffers() {
    // offered_appointment_id se CONSERVA: así a esa persona no se le repite el mismo cupo.
    // Sigue en la lista ('waiting') para los próximos cupos; su cita base no se toca.
    const expired = await db.query(
      `UPDATE waitlist SET offer_state = 'expired'
        WHERE offer_state = 'offered' AND offer_expires_at < now()
        RETURNING offered_appointment_id`);
    const ids = [...new Set(expired.rows.map(r => r.offered_appointment_id).filter(Boolean))];
    for (const id of ids) {
      const s = await db.query(
        `SELECT ${SLOT_COLS} FROM appointments a
          WHERE a.id = $1 AND a.status IN ('cancelled_client','cancelled_business')`, [id]);
      if (s.rows[0]) await offerSlot(s.rows[0]);
    }
  }

  // -- (2) Cuando se cancela una cita, ofrecer el cupo al primero compatible -----
  //    Revisamos citas recién canceladas que todavía no se le ofrecieron a nadie.
  async function offerFreedSlots() {
    const freed = await db.query(
      `SELECT ${SLOT_COLS} FROM appointments a
        WHERE a.status IN ('cancelled_client','cancelled_business')
          AND a.cancelled_at > now() - interval '5 minutes'
          AND a.starts_at > now()
          AND NOT EXISTS (SELECT 1 FROM waitlist w WHERE w.offered_appointment_id = a.id)`);
    for (const slot of freed.rows) await offerSlot(slot);
  }

  // -- (3) Recordatorio "te toca" a clientes inactivos --------------------------
  async function dueReminders() {
    const due = await db.query(
      `UPDATE clients c SET due_reminder_sent_at = now()
         FROM businesses b
        WHERE c.business_id = b.id
          AND b.due_reminder_enabled = true
          AND c.last_visit_at IS NOT NULL
          AND c.last_visit_at < now() - (b.due_reminder_days || ' days')::interval
          AND (c.due_reminder_sent_at IS NULL
               OR c.due_reminder_sent_at < now() - (b.due_reminder_days || ' days')::interval)
          AND c.is_blocked = false
        RETURNING c.business_id, c.phone, c.full_name`);
    for (const r of due.rows)
      await db.query(
        `INSERT INTO message_log (business_id, channel, recipient, template)
         VALUES ($1,'whatsapp',$2,'due_reminder')`, [r.business_id, r.phone]);
  }

  // Las dos tareas de ofertas nunca corren a la vez (así un cupo no se ofrece doble), pero
  // van en FILA: la que llega mientras la otra corre, espera y corre después. (Con un
  // "si está ocupado, sáltate", cada 60 s las dos arrancan juntas y rotateOffers perdía
  // siempre: las ofertas vencidas nunca pasaban al siguiente.) Una que ya está en fila
  // no se vuelve a apilar.
  let chain = Promise.resolve();
  const inLine = new Set();
  function runInLine(name, fn) {
    if (inLine.has(name)) return;
    inLine.add(name);
    chain = chain.then(fn).catch(e => console.error(name + ':', e.message)).finally(() => inLine.delete(name));
  }
  setInterval(() => runInLine('offers', offerFreedSlots), 30_000);
  setInterval(() => runInLine('rotate', rotateOffers), 60_000);
  setInterval(() => { dueReminders().catch(e => console.error('due:', e.message)); }, 3600_000); // cada hora

  console.log('  ✓ workers de fidelización activos (ofertas de lista de espera, te-toca)');
};
