# Membresías (add-on de $2.99 al mes)

El negocio vende membresías o paquetes que sus clientes pagan por adelantado. El negocio pone el precio, cuánto dura, cuántas visitas incluye, qué servicios cubre y sus propios términos. El pago le llega directo al negocio por sus métodos de siempre. Bukéame no toca ese dinero: solo lleva la cuenta de las visitas y de la fecha.

Código: `backend/module-membresias.js`, migración `database/38-schema-membresias.sql`, pantalla del negocio `frontend/membresias.html`, página del cliente `frontend/membresia.html?slug=<negocio>`.

## Cómo funciona

### Para el negocio (Panel → Membresías)
- **Crear una membresía.** Se escoge el nombre, el precio ($1 a $5,000), la duración (1 a 24 meses o 1 a 365 días) y las visitas incluidas (o sin límite). También se escoge qué servicios cubre (todos o algunos), si un "no llegó" gasta la visita y los términos. Hay un ejemplo de términos para editar.
- **Cambiarla** no toca las que ya se vendieron: cada una guarda la copia de lo que el cliente compró y aceptó.
- **Pausarla** la saca de la venta. **Borrarla** la saca para siempre. En los dos casos, las ya vendidas siguen valiendo.
- **Confirmar un pago.** Cuando el cliente paga por ATH al número o en persona, la membresía queda "Esperando pago". El negocio toca "Ya me pagó, activarla". Si no se confirma en 7 días, se cancela sola.
- **Vender en persona.** El negocio llena nombre, teléfono y cómo le pagaron. Queda activa enseguida y al cliente le llega su código.
- **Descontar o devolver una visita a mano**, para una visita que no se reservó en Bukéame o para perdonar un "no llegó".
- **Cancelar** una membresía hace que deje de valer desde ese momento. Si hay que devolver dinero, el negocio lo hace por donde le pagaron.
- **Agenda:** las citas pagadas con membresía llevan la etiqueta "Membresía". Al completarlas se cobran $0 (solo algo extra o la propina).

### Para el cliente
- En la página del negocio, en "Más opciones", sale **Membresías**. La página enseña lo que incluye cada una y los términos.
- Para comprar escribe nombre, WhatsApp y email, acepta los términos y escoge cómo pagar:
  - **ATH Móvil automático:** le llega la solicitud a su app y se activa al confirmar. Bukéame verifica el monto.
  - **Tarjeta:** paga por la cuenta de Stripe que el negocio conectó en Pagos, y se activa con el aviso de Stripe.
  - **ATH Móvil al número o en persona:** queda apartada hasta que el negocio confirme. El cliente puede dejar la referencia de ATH.
  - Si el negocio no tiene ninguna forma de pago conectada, solo se puede apartar y pagar en persona. El panel se lo avisa.
- Le llega su **código** (tipo `BA-MEM-7Q4RTX`) por email y WhatsApp.
- **Para usarla:** al reservar escribe el código con el mismo teléfono de la compra.
  - La reserva revisa que esté activa, que la fecha caiga dentro de su vigencia, que cubra los servicios y que le queden visitas.
  - Cada servicio de la cita gasta una visita, y la cita no pide depósito.
  - Si la cita se cancela, la visita vuelve.
- **Mi membresía:** con el código y el teléfono ve cuántas visitas le quedan y hasta cuándo vale.
- **Vigencia:** va por días enteros. Empieza el día que se activa y vale hasta el último día de su periodo, a cualquier hora.
- **Renovar:** 5 días antes de que venza le llega un recordatorio con el enlace (2 días antes si dura menos de 2 semanas; ninguno si dura menos de 4 días). Si renueva antes de tiempo y le quedan visitas, la nueva empieza cuando termina la otra. Si ya gastó todas, la nueva sirve desde hoy.

### Si el negocio deja de pagar el add-on
No se venden membresías nuevas y el botón de comprar sale de su página. Las que ya vendió se siguen usando hasta su fecha, porque el cliente ya pagó: el campo del código sigue en la reserva mientras haya alguna vigente.

### Pagos que no cuadran o que llegan dos veces
- Un pago con tarjeta solo activa la membresía si viene de la cuenta de Stripe de ese negocio, por el precio exacto y ya cobrado.
- Si el monto no cuadra, no se activa y el negocio recibe un aviso.
- Si un cliente paga dos veces (dos pestañas, dos intentos), el negocio recibe el aviso "Pago doble de una membresía" para devolver uno.

## Subirlo al servidor

Primero tiene que estar el código en GitHub. Después, un comando a la vez en el servidor:

```bash
cd /var/www/bukeame && git pull origin main
```

```bash
sudo -u postgres psql -d bukeame -f /var/www/bukeame/database/38-schema-membresias.sql
```

La migración se puede correr dos veces sin problema. Debe terminar en `COMMIT`. Las dos primeras líneas (`ALTER TYPE … ADD VALUE`) van fuera de la transacción a propósito; con `psql -f` eso funciona solo.

```bash
cd /var/www/bukeame/backend && node --check server.js && pm2 restart bukeame-api
```

```bash
pm2 logs bukeame-api --lines 40 --nostream | grep -i membres 1>&2
```

Debe salir `✓ módulo membresías montado`. No hace falta ninguna llave nueva.

### Probarlo con tu negocio
1. En el panel de admin, actívale el add-on "Membresías" a tu negocio. También se puede pagar desde Mi cuenta.
2. Panel → Membresías → Nueva membresía. Crea una de $1 con 1 visita.
3. Abre el enlace de tu página de membresías en otro teléfono y cómprala con "En el negocio".
4. En el panel, confírmala. Debe llegar el WhatsApp y el email con el código.
5. Reserva una cita escribiendo el código. Debe quedar confirmada, sin depósito, y salir con la etiqueta "Membresía" en la Agenda.

## Lo que se probó
Con el banco de pruebas (`scratchpad/bk2/backend/membresias-test.js`) pasaron 105 comprobaciones:
- con y sin el add-on;
- las validaciones;
- las 4 formas de pago, incluidos ATH con monto que no cuadra (se revisa antes de cobrar) y una sola solicitud de ATH abierta a la vez;
- el aviso de Stripe con firma mala, repetido, desde la cuenta de otro negocio, por otro monto o sin cobrar todavía, y el aviso al negocio si llega un segundo pago;
- el código con otro teléfono;
- los servicios que no cubre y las visitas que se acaban;
- cancelar devuelve la visita, y "no llegó" cuenta;
- los ajustes a mano;
- la renovación antes de tiempo (en fila si le quedan visitas; desde hoy si ya las gastó);
- la vigencia por días enteros de Puerto Rico;
- el negocio que deja de pagar;
- el trabajo de cada hora (vencer, cancelar las no pagadas, un solo recordatorio).

No se probó con ATH Móvil ni con Stripe de verdad.

## Pendiente o por decidir
- Que el abogado revise la línea nueva de los Términos sobre membresías.
- No hay cobro automático cada mes de la membresía del cliente: ATH Móvil no lo permite. El cliente la renueva comprándola otra vez desde el enlace del recordatorio.
- El IVU de lo que vende el negocio es cosa del negocio. Bukéame solo anota el pago.
