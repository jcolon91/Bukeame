# Pago a plazos: Klarna, Affirm y Acima

El cliente paga en partes y el negocio recibe el total de una vez. Bukéame no presta, no
custodia el dinero y no guarda llaves secretas de ninguno de los tres.

## Qué puede ofrecer cada negocio

| | Por su Stripe | Con su cuenta directa |
|---|---|---|
| **Klarna** | Sale sola en la página de pago con tarjeta cuando el negocio la activa en SU Stripe | El negocio le manda el enlace al cliente desde su portal de Klarna y en Bukéame lo anota al cobrar |
| **Affirm** | Igual que Klarna | El negocio usa la terminal virtual de Affirm (Business Hub) y lo anota al cobrar |
| **Acima** | No existe por Stripe | El negocio pega su enlace de solicitud de Acima y marca los artículos que se pueden arrendar |

Dónde se configura: **Panel → Pagos → Pago a plazos**. Hace falta plan Pro o más, como los
demás pagos en línea.

### Lo que hay que saber de cada uno (documentación oficial, nov-2026)

- **Klarna** sí sirve en Puerto Rico; es el único territorio de EE. UU. donde funciona. Paga en 4
  de $1 a $2,000, a 30 días de $5 a $1,000 y financiamiento de $45 a $10,000. Por Stripe cuesta
  5.99% + 30¢ por pago. **No se puede usar para vender gift cards** (por eso se quitó del aviso
  de `gift-card.html`).
- **Affirm** por Stripe solo se le enseña a clientes de EE. UU. y Canadá: Stripe mira el país de
  envío y, si no hay, el de la IP. A la mayoría de los clientes de Puerto Rico no les va a salir, y
  directo tampoco aceptan direcciones de PR. Va de $35 a $30,000 y cuesta 6% + 30¢. Masajes es
  categoría "restringida" para Affirm.
- **Acima** es arrendamiento con opción a compra, no préstamo: al final le sale más caro al
  cliente que de contado. Solo arrienda artículos duraderos de uso personal o del hogar de $300
  o más; servicios, ropa, gift cards y consumibles no. El negocio necesita su cuenta de
  comerciante (acima.com/partner). El mínimo se cambia con `ACIMA_MINIMO_CENTS` en el `.env`.

## Cobro por enlace desde el panel

En **Completar y cobrar** de una cita, si el negocio conectó su Stripe con el botón
"Conectar con Stripe" (OAuth, no el Payment Link), sale **Mandar enlace de pago**:

1. Crea una Checkout Session en la cuenta del negocio (cargo directo) por el servicio y la
   propina, que vence a las 23 horas.
2. El panel enseña un QR, "Copiar enlace" y "Enviar por WhatsApp" (abre el WhatsApp del negocio).
3. El cliente escoge tarjeta, Klarna o Affirm en la página de Stripe.
4. El webhook de Connect (`/api/payments/stripe/webhook`, metadata `kind=cobro`) completa la cita,
   cuenta la visita una vez, anota el pago con el método real (le pregunta al PaymentIntent) y le
   avisa al negocio. Solo vale si viene de la cuenta del negocio, por el total exacto, en dólares
   y cobrado. Repetir el evento no duplica nada.

Reglas que evitan cobrar dos veces o perder un pago:

- **Depósito:** si el cliente ya pagó un depósito, el cobro sale de entrada por lo que falta y lo dice.
- **Un solo enlace abierto por cita:** dos pestañas a la vez no hacen dos. Por el mismo total se
  devuelve el mismo; por otro, se cierra el anterior en Stripe primero.
- **Cerrar de verdad:** si Stripe no confirma que cerró el enlace, no se da por cancelado (502) y
  no se hace otro encima. Si al cerrarlo resulta que el cliente ya pagó, se anota en ese momento.
- **Completar, cancelar o "no llegó"** cierran antes los enlaces abiertos de la cita. Si el enlace
  ya estaba pagado, "Completar" da 409 y no se anota un segundo cobro. Completar una cita ya
  completada no vuelve a contar la visita.
- **Desconectar Stripe** cierra antes los enlaces abiertos. El webhook compara con la cuenta con la
  que se creó el enlace, no con la que esté conectada ahora.
- **Con qué pagó:** si Stripe no contesta, el webhook da 500 para que Stripe reintente, en vez de
  anotar "tarjeta" para siempre.
- **Eventos de prueba:** con la llave `sk_live_`, el webhook de Connect ignora los eventos de modo
  prueba de las cuentas conectadas (antes un pago de prueba confirmaba depósitos y órdenes).
- **"No cuadra"** avisa una sola vez por enlace.
- El enlace vuelve a la página del negocio, sin el código de la cita (el QR se escanea en pantalla
  y el enlace se reenvía). Al volver de pagar sale "Recibimos tu pago".
- Una cita cancelada, sin llegar o ya cobrada no hace enlace. Un pago que llega igual se anota (el
  dinero entró) y se le avisa al negocio, como cuando el cliente paga dos veces.

## Reglas copiadas de GOLDIE (6-nov-2026)

GOLDIE (que también cobra a plazos por Stripe, con Affirm, Klarna, Afterpay y Zip, sin Acima) solo
lo ofrece en cobros de más de $50 y en citas de aquí a 30 días. Bukéame hace lo mismo:

- **$50 o más y citas de aquí a 30 días.** Cada Checkout de Stripe del negocio (depósito, tienda,
  membresía y cobro por enlace) oculta Klarna y Affirm con `excluded_payment_method_types` cuando
  el cobro es menor, la cita es lejana o el negocio no los ofrece por Stripe en Bukéame. Solo se
  oculta lo que Stripe dijo que la cuenta tiene activo; si Stripe no acepta ocultarlo, la sesión se
  crea igual sin ocultar nada (no se cae el pago). Constantes `PLAZOS_MIN` y `PLAZOS_DIAS` en
  `module-plazos.js`.
- **Aviso en la página del negocio**: una tarjeta que se puede cerrar ("Puedes pagar a plazos con
  Klarna en pagos de $50 o más…") con enlace a **`plazos.html?slug=`**, la página que le explica al
  cliente cómo funciona, cada compañía (Affirm sin PR; Acima es arrendamiento) y las preguntas
  comunes. La fila "A plazos" de las normas también enlaza ahí.
- **No se copió**: pago a plazos de gift cards (Klarna lo prohíbe), comisión de plataforma ni
  cuentas Stripe manejadas por Bukéame, ni terminal física (el enlace con QR cubre lo de en persona).

En la página pública, el botón de tarjeta dice Klarna solo en pagos de $50 a $10,000 de citas de
aquí a 30 días, y nunca dice Affirm (no le sale a clientes de PR); Affirm se explica en la fila "A
plazos". Lo que dice Stripe de cada cuenta se refresca a diario, y si no se ha visto en 2 días no
se anuncia.

## Desplegar

1. `git pull`
2. `sudo -u postgres psql -d bukeame -f database/41-schema-plazos.sql`, después de la 38
   (las tres líneas `ALTER TYPE` van fuera de transacción; el archivo ya lo hace así).
3. `cd backend && node --check server.js && pm2 restart bukeame-api`
4. En los logs debe salir `✓ módulo pago a plazos montado`.
5. En el Dashboard de Stripe de Bukéame, el webhook de Connect ya escucha
   `checkout.session.completed` y `payment_intent.succeeded` de las cuentas conectadas; no
   hay que añadir eventos.

Sin la migración 41 el módulo no hace nada: el panel no enseña la sección y la página pública
sigue igual.

## Probado

En el banco local (`scratchpad/bk2`): `plazos-test.js` 91/91 con el Stripe simulado (capacidades
de la cuenta, PaymentIntent con su método, cerrar sesiones, fallas de Stripe y sesiones ya
pagadas), más las demás suites y el navegador (panel, enlace con QR, pago con Klarna simulado,
página pública en celular). Una revisión independiente halló 13 cosas: 12 arregladas en el
código y una (la 41 necesita la 38) resuelta con el orden de las migraciones. Sin probar con
Stripe real, ni con cuentas reales de Klarna, Affirm o Acima.

## Pendiente

- **API directa de Klarna y Affirm (sin Stripe): DECIDIDO QUE NO (6-nov-2026).** A diferencia
  de ATH, las dos exigen la llave secreta para cerrar cada venta, no solo para devoluciones
  (Affirm autoriza con pública + privada; Klarna crea la orden con su llave de API). Con la
  pública sola no se cobra. El dueño prefirió no guardar llaves: Klarna va por Stripe y lo
  directo se hace con el enlace del portal de cada uno.
- Probar en vivo con una cuenta Stripe de prueba conectada por OAuth: que Klarna aparezca en el
  checkout de una cuenta Standard, que `capabilities.klarna_payments` llegue en
  `GET /v1/accounts/:id` y que "active" ahí sea lo mismo que "prendido" en su checkout (si no,
  mirar `GET /v1/payment_method_configurations` con Stripe-Account).
- Confirmar si un Payment Link de "el cliente elige el monto" enseña Klarna; con solo el Payment
  Link, Bukéame le cree al negocio.
