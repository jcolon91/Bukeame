# Recupera clientes (add-on): cómo funciona y cómo se monta

**Qué es:** un servicio hecho por Wifnix, no una herramienta. El dueño no arma nada:
1. Bukéame mira sus citas y encuentra a los clientes que ya vinieron y no han vuelto.
2. La IA (Claude) escribe el email con los servicios y precios reales del negocio.
3. Una persona de Wifnix lo revisa y lo aprueba.
4. Sale con el nombre del negocio.
5. Cada mes el dueño ve cuántos volvieron y cuánto dejaron en citas.

A los que vinieron en la última semana se les pide una reseña en Google.

**Precio:** $49 al mes, con 1,500 emails por periodo pagado. Se cobra como cualquier add-on: ATH desde Mi cuenta, o el admin lo activa. El precio es el estimado de la calculadora (unos 20 minutos de revisión al mes por negocio) y falta que lo apruebes.

**No se vende hasta que el email esté listo:** mientras falte `RESEND_API_KEY` o `EMAIL_FROM_CAMPANAS` en el `.env`:
- el add-on no sale en Mi cuenta;
- no se puede pedir ni pagar por ATH;
- la página dice "Muy pronto";
- no sale ningún email.

El admin sí lo puede activar para probar.

Archivos:
- `backend/module-recupera.js`: rutas, planificador, envío, atribución e informe del mes.
- `frontend/recupera.html`: la página del dueño.
- `frontend/revisar-campanas.html`: la revisión de Wifnix (se entra desde el admin).
- `frontend/baja.html`: la página para darse de baja.
- `database/36-schema-recupera-clientes.sql`: la migración.

---

## Cómo trabaja

**Las campañas:**
- **Te extrañamos**, cada 14 días si hay 5 o más clientes que no han vuelto. "No ha vuelto" depende del cliente:
  - con 3 visitas o más, 1.5 veces su tiempo promedio entre visitas (entre 21 y 120 días);
  - con menos, los días que escoge el dueño (45 si no escoge).
- **Reseña en Google**, cada 7 días, a los que vinieron en la última semana. Solo si el dueño puso su enlace de reseñas.

Una "visita" es una cita completada o una confirmada que ya pasó, porque muchos negocios no marcan "completada".

**Reglas que protegen al cliente y al negocio:**
- Solo se le escribe a quien ya vino al negocio. Nunca se usan listas compradas ni se escribe en frío.
- Nadie recibe dos campañas en 21 días. La reseña se pide una vez cada 120 días.
- No se le escribe a quien tiene una cita por delante, a quien no viene hace más de un año, ni a un cliente bloqueado.
- Cada email lleva la dirección del negocio y un enlace para darse de baja. También lleva la baja de un clic que piden Gmail y Yahoo. Sin la dirección del negocio no se prepara ninguna campaña.
- La IA no inventa ofertas: copia la del dueño tal cual, si la puso. Los enlaces y emojis que meta se quitan solos. Si la IA falla, queda una plantilla escrita a mano.
- Las respuestas al email le llegan al negocio (reply-to), no a Bukéame.

**El dueño tiene la última palabra:**
- Al aprobarla, la campaña sale a las 10:00 a. m. del próximo día que deje 12 horas o más.
- Le llega un WhatsApp para verla y, si quiere, detenerla.
- Puede pausar todas las campañas en Ajustes.
- Una campaña que el dueño detuvo o que Wifnix rechazó no se rehace sola. Para otra antes de tiempo está "Preparar una ahora".

**La medición honesta:**
- Cuenta como que "volvió" quien hizo una cita en los 14 días siguientes al email; las canceladas no cuentan.
- Cuando el público tiene 40 o más clientes, el 10 % no recibe el email (grupo de control).
- El dueño ve cuántos de ese grupo volvieron sin el email. Así se sabe si la campaña de verdad trajo gente.
- El día 1 de cada mes le llega el resumen del mes anterior por WhatsApp y email.

**El copiloto de Wifnix:** la página de revisión dice cuántas de las últimas 50 salieron tal como las escribió la IA. Cuando eso pase de 90 % por varias semanas, se puede pensar en dejar que salgan solas. Hoy siempre las revisa una persona.

**Cupo:** 1,500 emails por periodo pagado del add-on (bloques de 30 días). Si una campaña no cabe, salen primero los clientes que más han gastado y el dueño ve a cuántos no les llegó. Para cambiarle el cupo a un negocio:

```sql
UPDATE rc_settings SET emails_included = 3000 WHERE business_id = '<id>';
```

---

## 1. Lo que hace Wifnix una sola vez

**a) Subdominio para campañas en Resend.** Las campañas salen de un subdominio aparte, por ejemplo `novedades.bukeame.com`. Así, si alguien las marca como spam, no se afectan las confirmaciones de citas.
1. En Resend, ve a **Domains → Add domain** y añade `novedades.bukeame.com`.
2. Copia los registros que te da (SPF, DKIM y MX) en el DNS de `bukeame.com`.
3. Añade también un registro DMARC si el dominio no lo tiene.
4. Espera a que Resend lo marque como **Verified**.

**b) Llave de Claude.** En <https://console.anthropic.com>, ve a **API Keys** y crea una llave llamada `bukeame-recupera`. En **Limits**, ponle un tope de gasto mensual (por ejemplo $20). Cada borrador cuesta unos centavos.

**c) En el servidor** (`ssh deploy@2.24.70.107`, un comando a la vez):

```bash
cd /var/www/bukeame && git pull origin main
```

```bash
cd /var/www/bukeame/backend && npm install --omit=dev 1>&2
```

```bash
sudo -u postgres psql -d bukeame -f /var/www/bukeame/database/36-schema-recupera-clientes.sql
```

Pon el remitente. Cambia la dirección si escogiste otro subdominio:

```bash
cd /var/www/bukeame/backend && printf '\nEMAIL_FROM_CAMPANAS=hola@novedades.bukeame.com\n' >> .env && grep '^EMAIL_FROM_CAMPANAS=' .env 1>&2
```

Pega la llave de Claude sin que se vea ni quede en el historial:

```bash
read -rsp 'Pega la API key de Claude y oprime Enter: ' K && printf '\nANTHROPIC_API_KEY=%s\n' "$K" >> /var/www/bukeame/backend/.env && unset K && echo ' guardada' 1>&2
```

```bash
cd /var/www/bukeame/backend && node --check server.js && pm2 restart bukeame-api
```

```bash
pm2 logs bukeame-api --lines 40 --nostream | grep -i recupera 1>&2
```

Debe salir `módulo Recupera clientes montado`.

**d) Piloto:**
1. Desde el panel de admin, dale el add-on **Recupera clientes** a un negocio que tenga clientes con email y su dirección puesta.
2. En su panel, en **Recupera clientes**, pon su enlace de reseñas de Google.
3. En el admin, entra a **Revisar campañas**. En **Preparar una ahora**, escoge el negocio y prepara una. Si no, espera a que el planificador la prepare (corre cada hora).
4. Revisa el texto contra los datos del negocio y aprueba. Usa **Aprobar y enviar ya** solo en pruebas: así no le llega el aviso al dueño.
5. Confirma que llegó el email y que el botón y la baja funcionan.

---

## 2. Lo que hace cada negocio (panel → Recupera clientes)

- **Sin el add-on:** ve cuántos clientes suyos no han vuelto y cuántos tienen email, el precio y el botón para activarlo.
- **Con el add-on:**
  - lo que ha traído: dólares en citas, cuántos volvieron y la comparación con el grupo de control;
  - sus campañas: cuándo salen, verlas y detenerlas;
  - cuántos clientes tienen email;
  - sus ajustes: pausar, su oferta, su enlace de Google y cuándo un cliente "no ha vuelto";
  - los emails que lleva en el periodo.

En el formulario de reserva, debajo del email, ahora dice que el negocio puede escribirle y que se da de baja con un toque.

---

## 3. Si algo falla

- **No se prepara ninguna campaña:** en **Revisar campañas**, "Preparar una ahora" dice el motivo, por ejemplo:
  - falta la dirección;
  - pocos clientes;
  - el dueño pausó;
  - se usaron los emails del periodo.
- **Una campaña se queda en "Saliendo":** Resend está dando error. Los envíos se reintentan cada 2 minutos y el Idempotency-Key evita duplicados. Mira `pm2 logs bukeame-api --lines 100 | grep recupera`.
- **Los borradores salen de la plantilla:** falta `ANTHROPIC_API_KEY`, o la llave no sirve o no tiene saldo. Lo dice la página de revisión y los logs (`recupera IA:`).

## Variables del `.env`

| Variable | Para qué |
|---|---|
| `RESEND_API_KEY` | La misma de los emails de citas |
| `EMAIL_FROM_CAMPANAS` | Remitente del subdominio de campañas. Sin él no se vende ni se envía |
| `ANTHROPIC_API_KEY` | La IA que redacta. Sin ella, plantillas escritas a mano |
| `RECUPERA_MODELO` | Modelo de Claude (por defecto `claude-opus-5-5`) |
| `RECUPERA_BASE_URL` | Dominio de los enlaces del email (por defecto `https://bukeame.com`) |

## Pendiente

- **Probarlo en vivo:** aún no se ha enviado nada por Resend ni se ha llamado a Claude de verdad. Las pruebas usaron simuladores.
- **El informe del día 1:** no se probó el disparo, solo los números que usa.
- **Rebotes y quejas:** Resend aparta solo los emails que rebotan, pero Bukéame todavía no lee su webhook para marcarlos en el cliente.
- **Política de privacidad:** que diga que los negocios pueden enviar emails promocionales a sus clientes, con baja. Revisarlo con abogado.
- **WhatsApp como segundo canal:** espera la API oficial de Meta (decisión pendiente). Por Evolution no se mandan campañas.
