# Difusiones por WhatsApp (add-on de $4.99 al mes)

El negocio escribe un aviso (los espacios de los próximos días, una oferta, una noticia) y le llega por WhatsApp a sus clientes **atendidos** que **aceptaron** recibir avisos.

Dónde está cada parte:
- **Código:** `backend/module-difusiones.js`.
- **Migración:** `database/39-schema-difusiones.sql`.
- **Pantalla del negocio:** `frontend/difusiones.html` (Panel → Difusiones).
- **Revisión de Wifnix:** `frontend/revisar-difusiones.html` (Admin → Avisos por WhatsApp).
- **Baja:** `frontend/baja.html?w=…`.

## El riesgo, y por qué hay tantos frenos

Los avisos salen del **mismo número de WhatsApp de Bukéame** que manda las confirmaciones y los recordatorios de citas de todos los negocios. Ese número va por Evolution, que no es la vía oficial de WhatsApp. Si mucha gente lo reporta como spam, WhatsApp lo puede bloquear y se caen los recordatorios de todos. Se escogió así a sabiendas el 5-nov-2026. Por eso:

- **Solo a quien dijo que sí y ya fue atendido** (una cita completada). Se puede aceptar de dos maneras:
  - **la casilla al reservar** en línea;
  - **el negocio lo marca** en el perfil del cliente. En ese caso además tiene que haber prueba de que es su cliente: que haya reservado en línea, o que le haya llegado el WhatsApp de una cita suya. Así un negocio no se puede inventar clientes con una lista comprada.
- **El primer aviso de cada negocio lo aprueba Wifnix.** Los siguientes salen solos.
- **Baja con un toque:** cada aviso trae un enlace para darse de baja de ese negocio o de todos. Para volver hay que entrar por el enlace de un mensaje propio, porque cualquiera puede reservar con un teléfono ajeno; ni el negocio ni una reserva pueden deshacer una baja.
- **Pausa automática:** si un aviso trae muchas bajas o muchos números sin WhatsApp, los avisos de ese negocio quedan en pausa hasta que Wifnix los revise:
  - muchas bajas son 5 o más que, además, sean el 15 % de los enviados;
  - muchos números sin WhatsApp son 5 o más que, además, sean el 25 %.
- **Sin enlaces:** ni en el aviso ni en el nombre del cliente o del negocio. Cualquier "palabra.palabra" cuenta como página web (también emails e IP). El único enlace lo pone Bukéame: el de reservar y el de la baja.
- **Despacio y repartido:**
  - un mensaje a la vez, con una pausa al azar;
  - solo de día;
  - los negocios se turnan;
  - hay un tope por día para todo Bukéame;
  - a una misma persona le llega como máximo 1 aviso al día y 3 a la semana, sumando todos los negocios;
  - entre un aviso y otro del mismo negocio tienen que pasar unos días.
- **Lo que no sale en 24 horas se cancela,** para que no lleguen "espacios de esta semana" viejos.
- **Si WhatsApp falla:**
  - Si un número no tiene WhatsApp, no se reintenta.
  - Si WhatsApp no contesta a tiempo, tampoco: pudo haber llegado y no se repite.
  - Si WhatsApp está caído, se reintenta hasta 3 veces, con 10 minutos entre intentos.
  - Con 3 fallas seguidas, todo se para 15 minutos.

### Ajustes en el `.env` del servidor (todos opcionales; se leen al reiniciar)

| Variable | Qué hace | Si no está |
|---|---|---|
| `DIFUSIONES_PAUSA=1` | Para todos los envíos de avisos. Los que estaban en fila esperan, y si pasan 24 horas se cancelan. | Envía |
| `DIFUSION_TOPE_DIA` | Máximo de avisos por día para todo Bukéame. Con `0` no sale ninguno. | 400 |
| `DIFUSION_MENSAJES_MES` | Mensajes al mes que trae el add-on para cada negocio | 500 |
| `DIFUSION_DIAS_ENTRE` | Días mínimos entre avisos del mismo negocio | 3 |
| `DIFUSION_HORAS` | Horario de envío, hora de PR (`9-19` = de 9 a. m. a 7 p. m.) | 9-19 |
| `DIFUSION_PAUSA_MS` | Pausa entre un mensaje y otro (va de 0.75× a 1.5× al azar) | 20000 (20 s) |
| `DIFUSION_REVISAR_PRIMERA=0` | Quita la revisión de Wifnix del primer aviso | Se revisa |

Con 20 segundos de pausa, 400 avisos tardan unas 2 horas y media. Después de cambiar el `.env`, reinicia con `pm2 restart bukeame-api --update-env`. Para cambiar el precio del add-on se edita `addon_catalog` ('broadcasts').

Los avisos de "por revisar" y "en pausa" llegan por email a `ADMIN_ALERT_EMAIL`; si no está, a los administradores de la plataforma.

## Cómo funciona para el negocio
1. Activa el add-on en Mi cuenta.
2. Consigue que sus clientes acepten: la casilla sale sola en la reserva, y en Clientes → perfil puede tocar "Me dijo que sí". El perfil le dice si de verdad le va a llegar, o qué falta.
3. Panel → Difusiones: escribe el aviso o toca "Poner mis espacios de los próximos días" (sus espacios libres de los próximos 7 días, para su primer servicio). Ve cómo le llega al cliente y a cuántos.
4. Toca Enviar.
   - El primero espera la aprobación de Wifnix.
   - Los siguientes salen poco a poco.
   - Lo puede detener mientras sale, y cuando termina le llega un aviso con cuántos salieron.

El mensaje que recibe el cliente:

```
📣 *Kelvo Barber*
¡Hola, Ana!

(el aviso del negocio)

Reserva aquí: https://bukeame.com/negocio.html?slug=kelvo-barber

¿No quieres más avisos de Kelvo Barber? Date de baja aquí: https://bukeame.com/baja.html?w=…
```

## Subirlo al servidor

Primero tiene que estar el código en GitHub. Después, un comando a la vez en el servidor:

```bash
cd /var/www/bukeame && git pull origin main
```

```bash
sudo -u postgres psql -d bukeame -f /var/www/bukeame/database/39-schema-difusiones.sql
```

```bash
cd /var/www/bukeame/backend && node --check server.js && pm2 restart bukeame-api
```

```bash
pm2 logs bukeame-api --lines 40 --nostream | grep -i difusion 1>&2
```

Debe salir `✓ módulo difusiones montado`. No hace falta ninguna llave nueva: usa el WhatsApp que ya está.

### Probarlo con tu negocio
1. En el panel de admin, actívale el add-on "Difusiones por WhatsApp" a tu negocio.
2. Reserva una cita en línea con tu teléfono marcando la casilla de avisos, y complétala en la Agenda.
3. Panel → Difusiones: escribe un aviso corto y envíalo.
4. Admin → Avisos por WhatsApp: apruébalo. Debe llegarte en unos minutos.
5. Toca el enlace de baja del mensaje. El aviso siguiente ya no te debe llegar.

## Lo que se probó
Con el banco de pruebas (`scratchpad/bk2/backend/difusiones-test.js`). No se probó con el WhatsApp de verdad, ni el horario y el tope diario de todo Bukéame (se ajustan por `.env`).

**A quién le llega y qué dice:**
- a quién le llega: no a los que no aceptaron, ni sin cita, ni de baja, ni bloqueados, ni a los marcados por el negocio sin prueba;
- el filtro de enlaces (también dominios raros, el punto chino, emails e IP) y que deja precios y horas;
- el nombre de cliente con enlace, que no sale en el saludo, y el negocio con nombre de página web, que no envía;
- los espacios con día y fecha.

**La revisión y la pausa:**
- la revisión del primer aviso (aprobar y no aprobar);
- la pausa automática por bajas y quitarla.

**La baja:**
- la baja, que el negocio y una reserva no la deshagan, y volver desde el enlace propio;
- "ningún negocio".

**Los topes y el envío:**
- el tope del mes (le llega a los más recientes) y el tope por teléfono;
- detener un envío;
- el negocio que deja de pagar a mitad;
- cancelar lo que no salió en 24 horas y lo trabado;
- WhatsApp que falla (número sin WhatsApp y caído).

## Pendiente o por decidir
- Que el abogado revise el párrafo nuevo de la Política de privacidad (sección 4).
- Si con el tiempo hay muchos negocios enviando, vale la pena pasar los avisos al WhatsApp oficial de Meta, para no arriesgar el número de los recordatorios.
