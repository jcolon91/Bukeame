# Cobro con tarjeta (Stripe): mensualidades que se renuevan solas

**Qué es:** el dueño puede pagar su plan o sus add-ons con tarjeta y se cobran solos cada mes. ATH Móvil sigue igual: paga un mes y lo renueva él. La tarjeta es la otra opción, al mismo precio.

**No se ve hasta que pongas las llaves:** mientras falte `STRIPE_SECRET_KEY` o `STRIPE_BILLING_WEBHOOK_SECRET` en el `.env`, Mi cuenta enseña solo ATH, como hoy, y no se llama a Stripe. Se puede subir el código antes de tener la cuenta.

Archivos:
- `backend/module-tarjeta.js`: el cobro, el webhook, cancelar, quitar la tarjeta y el conciliador.
- `frontend/panel.html` (Mi cuenta): los botones de tarjeta y la tarjeta "Tarjeta y facturas".
- `database/37-schema-cobro-tarjeta.sql`: la migración.
- Términos (`terminos.html` y `terms.html`): una línea nueva sobre el cobro con tarjeta.

---

## Cómo funciona

**Lo que ve el dueño en Mi cuenta:**
- **Al subir de plan o escoger add-ons:** dos botones, "Pagar con tarjeta (cada mes)" y "Pagar con ATH Móvil (un mes)".
- **En lo que ya paga por ATH:** "Activar cobro automático".
- **En lo que va en tarjeta:**
  - dice "Se renueva solo con tarjeta" y la fecha del próximo cobro;
  - tiene "Cancelar" (o "Cancelar la renovación" en el plan);
  - si ya lo canceló, tiene "Reanudar".
- **Tarjeta y facturas:** abre la página de Stripe para cambiar la tarjeta, bajar facturas o cancelar.
- **Quitar tarjeta y cobro automático:** un botón rojo, a la vista. Borra la tarjeta de Stripe y no se le cobra nada más.

Antes de ir a Stripe, el panel le dice en palabras lo que se va a cobrar hoy y cada cuánto. Lo calcula el servidor, así que coincide con lo que cobra Stripe.

**Las reglas del cobro:**
- **Compra nueva:** se cobra hoy y después cada mes.
- **Algo ya pagado por ATH, o el plan en su prueba gratis:** hoy no se cobra nada. El primer cobro es el día que se acaba lo pagado.
- **Subir de plan pagado por ATH:** hoy se descuenta lo que le quedaba del plan de antes.
- **Subir de plan con el plan en tarjeta:** se cobra hoy la diferencia por los días que quedan del mes.
- **Bajar de plan:** no se hace solo. El panel le pide que escriba por WhatsApp.
- **Lo que no va en tarjeta:** el destacado y el presupuesto de anuncios, porque no son mensualidades. Siguen por ATH.

**Lo pagado siempre se respeta:**
- **Cancelar o apagar un add-on:** deja de renovarse, pero lo conserva hasta el final de lo pagado. El mes siguiente no se cobra mientras siga apagado.
- **Quitar la tarjeta:**
  - todo lo que estaba en tarjeta se cancela al final de su periodo;
  - lo que tenía un pago atrasado se cancela ya;
  - el plan y los add-ons siguen activos hasta su fecha.

  Después puede pagar con ATH o volver a poner una tarjeta. Si vuelve a ponerla, el primer cobro es cuando se acabe lo pagado.
- **Pago atrasado:** se usan los mismos 7 días de gracia que con ATH. Después, el plan baja a gratis y el add-on se apaga. Si Stripe deja el cobro "sin pagar" en vez de cancelarlo, Bukéame lo cancela para que el dueño pueda pagar por ATH o con otra tarjeta.

**Para que nunca se cobre dos veces:**
- Lo que va en tarjeta no se puede pagar otra vez por ATH.
- Cada factura se anota una sola vez (en `platform_payments`).
- Solo una factura PAGADA da días. Los demás avisos de Stripe solo copian el estado: cancelación, pago atrasado y renglones quitados.
- Si se pierde un aviso de Stripe, el conciliador revisa cada hora lo que vence en menos de 12 horas.

**Los avisos al dueño:**
- **Pago recibido:** aviso en el panel y recibo por email, con la marca de Bukéame.
- **Tarjeta que falla:** WhatsApp y email al primer intento, y otra vez cuando Stripe deja de intentar.

**Borrar la cuenta:** antes de borrar, se cancelan todos sus cobros con tarjeta. Si Stripe no contesta, no se borra y se le pide intentar más tarde.

---

## 1. Lo que haces una sola vez en Stripe

Empieza en **modo de prueba**. No uses llaves de verdad hasta probar todo.

**a) La cuenta.** Si ya abriste Stripe para Connect, es la misma cuenta. Si no, ábrela a nombre de Wifnix LLC con su banco.

**b) La llave secreta de prueba.** En **Developers → API keys**, copia la **Secret key** (`sk_test_…`). No la pegues en ningún chat: va directo al servidor (paso 2).

**c) El webhook.**
1. En **Developers → Webhooks**, crea un destino nuevo de **tu cuenta** (no de cuentas conectadas).
2. Ponle esta URL: `https://bukeame.com/api/billing/stripe/webhook`
3. Escoge estos eventos:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `customer.subscription.paused`
   - `customer.subscription.resumed`
4. La versión de la API da igual: Bukéame vuelve a pedir cada factura con la versión de su librería (2026-10-28.endive).
5. Copia el **Signing secret** (`whsec_…`). Es otro distinto al del webhook de Connect.

**d) Cobros que fallan.** En **Settings → Billing → Subscriptions and emails**:
- **Reintentos:** que Stripe reintente hasta **1 semana**. Así cuadra con los 7 días de gracia.
- **Si fallan todos los reintentos:** **cancelar la suscripción**.
- **Emails de Stripe:**
  - pagos con tarjeta que fallan: **sí** (traen el enlace para cambiar la tarjeta);
  - tarjetas por vencer: **sí**;
  - pagos que entran: **no**, porque Bukéame ya manda su recibo.

**e) Cómo sale en el estado de cuenta.** En **Settings → Public details**, pon el descriptor `BUKEAME` y el teléfono y el email de soporte. Si quieres, pon el logo y los colores en **Branding**.

**f) El portal "Tarjeta y facturas":** no hay que hacer nada. Bukéame lo configura solo la primera vez:
- se cancela al final del periodo;
- no se pausa;
- no se cambia de plan allí.

**Lo que cobra Stripe:** la tarifa estándar en EE. UU. es 2.9% + 30¢ por cobro, y Billing suma alrededor de 0.7%. Verifícalo en tu cuenta. En un add-on de $4.99 eso es cerca de 50¢.

---

## 2. En el servidor

Entra con `ssh deploy@2.24.70.107` y corre un comando a la vez.

```bash
cd /var/www/bukeame && git pull origin main
```

```bash
cd /var/www/bukeame/backend && npm install --omit=dev 1>&2
```

```bash
sudo -u postgres psql -d bukeame -f /var/www/bukeame/database/37-schema-cobro-tarjeta.sql
```

Revisa si ya hay una llave de Stripe en el `.env`. Debe salir un número; 0 quiere decir que no hay:

```bash
grep -c '^STRIPE_SECRET_KEY=' /var/www/bukeame/backend/.env 1>&2
```

Si salió 0, pega la llave secreta. No se ve ni queda en el historial:

```bash
read -rsp 'Pega la llave secreta de Stripe (sk_...) y oprime Enter: ' K && printf '\nSTRIPE_SECRET_KEY=%s\n' "$K" >> /var/www/bukeame/backend/.env && unset K && echo ' guardada' 1>&2
```

Pega el secreto del webhook:

```bash
read -rsp 'Pega el Signing secret del webhook (whsec_...) y oprime Enter: ' K && printf '\nSTRIPE_BILLING_WEBHOOK_SECRET=%s\n' "$K" >> /var/www/bukeame/backend/.env && unset K && echo ' guardado' 1>&2
```

**Modo piloto:** mientras pruebas con las llaves de prueba, solo tu negocio de prueba debe ver la tarjeta. Busca su id:

```bash
sudo -u postgres psql -d bukeame -tAc "SELECT id, name FROM businesses WHERE name ILIKE '%wifnix%'" 1>&2
```

Ponlo en el `.env`. Cambia el id por el que salió:

```bash
printf '\nTARJETA_PILOTO=<id-del-negocio>\n' >> /var/www/bukeame/backend/.env && grep '^TARJETA_PILOTO=' /var/www/bukeame/backend/.env 1>&2
```

```bash
cd /var/www/bukeame/backend && node --check server.js && pm2 restart bukeame-api
```

```bash
pm2 logs bukeame-api --lines 40 --nostream | grep -i tarjeta 1>&2
```

Debe salir `módulo cobro con tarjeta montado (Stripe Billing, solo piloto: 1 negocio(s))`.

---

## 3. Probar con la tarjeta de prueba

En el panel del negocio piloto, ve a **Mi cuenta**.
1. Escoge un add-on barato y toca **Pagar con tarjeta**. Lee el aviso y toca **Ir a la página de pago**.
2. En Stripe, paga con la tarjeta `4242 4242 4242 4242`, una fecha futura cualquiera, cualquier CVC y cualquier código postal.
3. Al volver debe decir "Listo, recibimos tu pago". El add-on queda "Se renueva solo con tarjeta el …" y te llega el recibo por email.
4. Toca **Cancelar** en ese add-on: debe quedar "Renovación cancelada — activo hasta …". Después toca **Reanudar**.
5. Abre **Tarjeta y facturas**: debe salir la página de Stripe con la factura.
6. Toca **Quitar tarjeta y cobro automático**. El add-on debe seguir activo hasta su fecha, y en Stripe la suscripción debe quedar cancelada al final del periodo.
7. En Stripe, en **Developers → Webhooks**, todos los eventos deben estar en 200.

---

## 4. Pasar a cobros de verdad

1. En Stripe, sal del modo de prueba.
2. Repite **1c** en modo real: es otro webhook con otro secreto.
3. Repite **1d** y **1e** si Stripe no los copió.
4. En el servidor, cambia las dos líneas del `.env` por las llaves de verdad (`sk_live_…` y el `whsec_…` nuevo). Ábrelo con `nano /var/www/bukeame/backend/.env` y borra las de prueba.
5. Para abrir la tarjeta a todos, borra la línea `TARJETA_PILOTO`. Si quieres un piloto real primero, pon ahí el id de Los Pelaos.
6. Reinicia con `pm2 restart bukeame-api`.

---

## Si algo falla

- **El dueño volvió de Stripe y dice "Tu pago se está confirmando":** Stripe todavía no contestó. Se arregla solo con el webhook o con el conciliador. Mira `pm2 logs bukeame-api --lines 100 | grep tarjeta`.
- **Un webhook sale con 400 en Stripe:** el `STRIPE_BILLING_WEBHOOK_SECRET` no es el de ese destino (no confundir con el de Connect).
- **Un webhook sale con 500:** Bukéame dio error al procesarlo y Stripe lo reintenta solo. El error sale en los logs.
- **"No pudimos cancelar el cobro con tarjeta":** Stripe no contestó y no se canceló nada. Se puede reintentar, o cancelar desde **Tarjeta y facturas**.

## Variables del `.env`

| Variable | Para qué |
|---|---|
| `STRIPE_SECRET_KEY` | La llave secreta de la cuenta (la misma de Connect) |
| `STRIPE_BILLING_WEBHOOK_SECRET` | El secreto del webhook de la cuenta. Sin él no se ofrece la tarjeta |
| `TARJETA_PILOTO` | Ids de negocios separados por coma: solo ellos ven la tarjeta. Vacío = todos |
| `APP_URL` | El dominio para volver de Stripe (por defecto `https://bukeame.com`) |
| `TARJETA_CONCILIAR_MS` | Cada cuánto corre el conciliador (por defecto 1 hora) |
| `STRIPE_API_BASE` | Solo para pruebas con un Stripe simulado. Nunca en el servidor |

## Pendiente

- **Probarlo con Stripe de verdad:** las pruebas usaron un Stripe simulado (99 comprobaciones). Falta el paso 3 con la cuenta real en modo de prueba.
- **IVU:** no se cobra impuesto con la tarjeta, igual que con ATH. Decídelo con el contador. Stripe Tax se puede prender después.
- **Términos:** se añadió una línea sobre el cobro con tarjeta. Que lo revise el abogado junto con la ley de renovación automática.
- **Descuento de referidos ($5 al mes):** no se aplica ni en ATH ni en tarjeta. En tarjeta se haría con un cupón de Stripe.
- **Bajar de plan con tarjeta:** hoy se hace a mano. Se podría programar para el próximo cobro.
- **Planes anuales:** no se ofrecen con tarjeta.
