# Mudanza a Bukéame (gratis)

Un negocio que viene de Booksy, Fresha, GOLDIE, Square, Vagaro u otra plataforma, o de su libreta y su celular, pasa a Bukéame lo que tenía: sus servicios, sus clientes, las citas que vienen, las visitas y las ventas de antes, y lo que les debe a sus clientes (tarjetas de regalo, paquetes prepagados y puntos de lealtad). Es lo que la página principal promete con "migrar tus clientes e importar servicios: gratis".

Dónde está cada parte:
- **Código:** `backend/module-mudanza.js` (rutas, resumen, mudar y deshacer) y `backend/mudanza-lector.js` (leer encabezados, fechas, dinero, teléfonos; sin base de datos).
- **Migración:** `database/40-schema-mudanza.sql` (va después de la 38, membresías).
- **Pantalla:** `frontend/mudanza.html` (Panel → Mudanza). En el panel también sale un aviso en la Agenda los primeros 30 días, y un enlace cuando Servicios o Clientes están vacíos.
- **Donde se ve lo mudado:** el perfil del cliente ("Antes de Bukéame"), Contabilidad ("Ventas antes de Bukéame") y Admin ("Mudanzas desde otras plataformas", solo conteos).

## Cómo funciona

1. El negocio escoge de dónde viene y la página le dice cómo bajar sus archivos de esa plataforma (según sus guías de ayuda; los menús pueden cambiar).
2. Sube los archivos: CSV, Excel (con varias hojas), ZIP (como el de GOLDIE), contactos del celular (.vcf, o "Escoger de mis contactos" en Android) o una foto de su lista de precios. **El archivo se lee en su equipo**; al servidor solo llegan las filas.
3. Bukéame reconoce qué trae cada archivo y qué columna es cada cosa. Primero por los encabezados de siempre (en inglés y en español). Solo si no queda claro le pregunta a Claude, que ve los encabezados y la **forma** de 3 filas ("Ana Ríos" llega como "Xxx Xxxx"; un teléfono, como "999 999 9999"): nunca datos de clientes. Un encabezado que no es de los de siempre le llega como "Columna N" (en una lista hecha a mano sin encabezados, la primera fila es un cliente), y tampoco ve el nombre del archivo.
4. El negocio ve el resumen: qué pasa, qué ya estaba y qué se queda fuera, fila por fila y con su porqué. Puede cambiar qué trae un archivo, escoger otra columna, quitar un archivo, decir a quién de su equipo le toca cada nombre de las citas y si las citas mudadas reciben recordatorios.
5. Si hay saldos (tarjetas, paquetes o puntos), tiene que marcar que los revisó.
6. "Mudar todo": se guarda en una sola transacción. Si algo falla, no se guarda nada.
7. Durante **7 días** la puede deshacer.

## Qué pasa con cada cosa

- **Servicios:** se crean con su duración y su precio, ligados a todo el equipo. Si ya había uno con ese nombre, se queda como está. Sin duración, van de 30 minutos (y el resumen lo dice).
- **Clientes:** se juntan por teléfono (de Puerto Rico o EE. UU.). Al que ya estaba solo se le llena lo que le faltaba (email, notas): **nunca se le cambia el nombre**. Un cliente que ya estaba en Bukéame se reconoce por teléfono o email, **nunca solo por el nombre** (dos personas se pueden llamar igual); el nombre solo sirve para juntar filas de los archivos de la misma mudanza. Sin teléfono no se pueden pasar (en Bukéame el teléfono es obligatorio) y salen en "lo que se queda fuera". Las notas llegan como "De Fresha: …", con el cumpleaños si lo traía.
- **Citas que vienen:** van a la Agenda como confirmadas, con un código `MD-…`. Si un archivo trae la misma cita en dos filas (un servicio por fila), se juntan. La que choca con otra cita del mismo profesional no se pasa, y al final se dice cuál es para que el negocio la ponga. Las canceladas no se pasan. Lo que todavía no pasa va a la agenda aunque el archivo diga "Paid" o "Completed": el estado se compara entero ("Unpaid" o "Incomplete" no son "completada") y una columna de "Payment Status" no se toma como estado. Las horas son de Puerto Rico; si las fechas se pueden leer de dos maneras (05/03), el negocio escoge en el resumen si vienen mes/día o día/mes. Hasta 3,000 citas por mudanza. Las citas mudadas cuentan para el tope de citas del mes del plan, y si con ellas se llega, el resumen lo avisa.
- **Recordatorios:** a las citas mudadas les llegan los de siempre (24 y 2 horas antes). Si es lo primero que esa persona recibe de ese negocio por Bukéame, el mensaje empieza con "Ahora tus citas con *Negocio* llegan por Bukéame". El negocio los puede apagar para esa mudanza. Como el WhatsApp es el mismo para todos los negocios, cada mudanza pone recordatorio a **60 citas por día** como máximo; las demás pasan sin recordatorio y el resumen lo dice. Los nombres de servicio con enlaces se cambian por "Servicio". **Mudar no le escribe a nadie.**
- **Visitas de antes:** van a `client_import_history`, no a citas. Por eso no suben la lealtad, no disparan el "te toca" y no cuentan para las difusiones. El cliente también guarda un resumen (visitas, total gastado, última visita) en columnas aparte (`imported_*`), no en `total_visits` ni `last_visit_at`.
- **Ventas de antes:** van a `imported_sales`, **aparte de la contabilidad de Bukéame**, porque ya se reportaron en la otra plataforma. Contabilidad las enseña por mes y se bajan en CSV.
- **Mudar dos veces lo mismo** (por ejemplo, si el servidor tardó y el negocio creyó que falló): lo que ya pasó no se repite. Las tarjetas se reconocen por su código viejo, los paquetes por cliente y nombre, los puntos por cliente, y las ventas y visitas por fecha, monto y servicio. El resumen avisa que ya hubo una mudanza, y si la página pierde la respuesta del servidor, revisa si se hizo antes de decir que falló.
- **Tarjetas de regalo:** quedan activas con su saldo y **siempre con un código nuevo de Bukéame**, al azar. El viejo puede ser corto o seguido (00001234) y se podría adivinar; además, probarlo contra los de Bukéame diría si existe en otro negocio. El viejo queda en `legacy_code` y el resultado da la lista (y un CSV) para avisarle a cada cliente. Para cobrar con ellas hace falta el add-on de Gift cards.
- **Paquetes prepagados:** pasan como membresías activas con las visitas que le quedan, a **$0** en Bukéame (se pagaron allá; no cuentan como ventas del mes). Si el archivo no dice cuándo vencen, el negocio escoge cuánto valen (6 meses si no toca nada). Se usan aunque el negocio no tenga el add-on de Membresías. No reciben el recordatorio de renovar (se compraron en la otra plataforma).
- **Puntos de lealtad:** se suman al programa de lealtad del negocio (tiene que existir). El negocio dice cuántos puntos de allá son una visita aquí.
- **Avisos por WhatsApp:** nadie que llega con la mudanza queda apuntado. Las difusiones siguen pidiendo el sí de cada cliente, y el WhatsApp de una cita mudada **no cuenta como prueba** de que es su cliente (en `module-difusiones.js` y en el perfil): esa cita la puso el negocio desde un archivo.
- **Reseñas:** no se pasan. Saldrían como escritas en Bukéame sin serlo.

## Deshacer

Se borra lo que la mudanza creó y nadie ha usado: citas sin cobro ni reseña, visitas y ventas de antes, tarjetas sin gastar, paquetes sin usar, puntos que nadie movió (ni canjeó un premio), clientes que no tienen nada más en Bukéame y servicios que ninguna cita usa (esos se archivan). Un cliente o un servicio que el negocio editó después de mudar se queda. Se deshace al revés de como se hizo. Lo que ya tiene movimiento se queda y el negocio ve cuánto. A los clientes que ya estaban les vuelve lo de antes, pero solo en lo que nadie cambió después.

## Topes y privacidad

- Hasta 12 archivos por mudanza (24 contando los que el negocio quita), 20,000 filas por archivo (uno más grande se baja por partes) y 60,000 en total.
- Las filas suben comprimidas (gzip): un archivo de miles de clientes cabe en 1 MB, que es lo que Nginx deja pasar si no se cambia. El servidor acepta hasta 25 MB ya descomprimidos y **lee el cuerpo después de revisar la sesión** (`server.js` no lo lee para `/api/mudanza`), con un tope de 60 análisis por hora por negocio.
- Claude: hasta 40 llamadas por negocio al día (columnas y fotos). La foto se achica en el equipo y no se guarda. Modelo: `MUDANZA_MODELO` en el `.env` (si no está, `claude-opus-5-5`). Sin `ANTHROPIC_API_KEY` todo funciona igual, salvo la foto del menú (el botón no sale).
- El borrador guarda las filas (traen datos de clientes) hasta que se muda; si no se muda, se borran a las 24 horas. A los 30 días de mudar, el resumen guardado se queda solo con los conteos (sin los nombres de las citas que chocaron ni la lista de códigos).
- Solo el dueño del negocio entra a la mudanza.
- Párrafos nuevos en Privacidad (sección 7 y la tabla de proveedores, con Anthropic) y en Términos (sección 7), en español y en inglés. **Que los revise el abogado.**

## Subirlo al servidor

Primero tiene que estar el código en GitHub y la migración 38 corrida. Después, un comando a la vez en el servidor:

```bash
cd /var/www/bukeame && git pull origin main
```

```bash
sudo -u postgres psql -d bukeame -f /var/www/bukeame/database/40-schema-mudanza.sql
```

```bash
cd /var/www/bukeame/backend && node --check server.js && pm2 restart bukeame-api
```

```bash
pm2 logs bukeame-api --lines 40 --nostream | grep -i mudanza 1>&2
```

Debe salir `✓ módulo mudanza montado`. No hace falta ninguna llave nueva (usa la de Claude que ya está para Recupera clientes).

Si un negocio con archivos muy grandes ve "son demasiado grandes", es el tope de Nginx (1 MB si no se cambió). Para subirlo solo en la mudanza, en `/etc/nginx/sites-available/bukeame.com` se copia el bloque `location /api/` como `location /api/mudanza/` con `client_max_body_size 25m;` adentro, y después `sudo nginx -t && sudo systemctl reload nginx`.

### Probarlo con tu negocio
1. Panel → Mudanza → "Otra plataforma". Sube un CSV con dos o tres clientes tuyos de prueba (nombre y teléfono) y una cita para mañana.
2. Revisa el resumen y muda.
3. En Clientes abre uno: debe salir "Antes de Bukéame". En la Agenda debe estar la cita.
4. En Panel → Mudanza, deshazla. Los clientes y la cita se deben ir.

## Lo que se probó (banco de pruebas, 6-nov-2026)

- `mudanza-test.js`: 92 de 92 contra el servidor de prueba con Claude y WhatsApp simulados. Cubre:
  - archivos como los de Fresha, Square y Vagaro;
  - un reporte con título arriba;
  - repetidos y lo que se queda fuera;
  - Claude solo con la forma de las filas;
  - ajustar columnas;
  - choques;
  - mudar sin saldos confirmados;
  - cada tabla después de mudar;
  - el recordatorio que se presenta;
  - la foto;
  - los topes;
  - deshacer con cosas que ya tienen movimiento;
  - los 7 días y el borrador de 24 horas;
  - lo que encontró la revisión independiente: mudar dos veces lo mismo, la lista sin encabezados, la subida comprimida, el cuerpo sin sesión, el tope de 60 recordatorios por día, la prueba de las difusiones y el deshacer que respeta lo editado y lo canjeado.
- `mudanza-lector`: 28 pruebas de fechas (también ISO sin zona, UTC y +0000), horas, dinero, duraciones, teléfonos, estados de cita, letras de cualquier idioma al tapar y detección de archivos.
- En el navegador:
  - un Excel de dos hojas, un ZIP con dos CSV, un CSV de Excel viejo con punto y coma y acentos, y contactos .vcf con caracteres especiales;
  - el resumen, mudar, el perfil, Contabilidad, el aviso de la Agenda y deshacer;
  - en el celular sin moverse de lado.
- **No se ha probado** con archivos reales de cada plataforma: los encabezados salen de sus guías de ayuda. El primer negocio que se mude es la prueba de verdad; si un archivo no se reconoce, Claude o el propio negocio escogen las columnas.

## Pendiente o por decidir

- Conexión directa con Square (su API oficial, con permiso del negocio): necesita crear una app gratis en el portal de desarrolladores de Square.
- Que Wifnix haga la mudanza por un negocio desde Admin: hoy el admin solo ve la lista. Hacerla por él necesitaría entrar como ese negocio, que es un cambio de seguridad aparte.
