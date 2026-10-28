# Recepcionista IA (add-on) — cómo funciona y cómo se monta

**Qué hace:** cuando un negocio no coge el teléfono, la llamada pasa a una recepcionista con IA. La recepcionista:
- contesta en español de PR y da precios y horario,
- busca horas libres en Bukéame y reserva la cita,
- le deja al dueño por WhatsApp lo que no pueda resolver.

El cliente recibe el mismo WhatsApp de confirmación (o de depósito) que si hubiera reservado en la web. Siempre dice que es una IA y que la llamada se graba: en PR la grabación necesita el permiso de las dos partes.

**Precio:** $39/mes con 150 minutos (unas 60 llamadas). Se cobra como cualquier add-on: ATH desde Mi cuenta, o el admin lo activa.

**Cómo está hecho:**
- **Un solo agente plantilla en Retell sirve a todos los negocios.** La cuenta de Retell es de Wifnix y los negocios nunca entran a Retell.
- **Cada negocio tiene su propio número de Retell.** Bukéame lo compra solo cuando el dueño toca "Activar mi línea".
- **En cada llamada, Retell le pregunta a Bukéame de qué negocio es el número** (`/api/voz/entrante`). Bukéame le contesta con el nombre, el tipo de negocio, la voz, el saludo, las preguntas frecuentes, los apodos de servicios y el modo. Lo demás (servicios, precios, equipo, horario) la IA lo consulta en vivo.
- **Las funciones de la llamada** (`/api/voz/fn/...`) usan las mismas rutas públicas de la web, así que pasan por las mismas validaciones, depósitos y avisos de WhatsApp.
- **Al terminar la llamada**, Retell manda la duración, el costo, el resumen y la grabación (`/api/voz/eventos`). De ahí salen los minutos y la lista de llamadas del panel. Si un evento se pierde, el revisor (cada 30 min) le pide la llamada a Retell.
- **Falla cerrado:** los números se compran sin agente fijo. Si Bukéame no contesta o algo falla, la llamada se rechaza en vez de conectarse sin control: Wifnix no paga llamadas de negocios sin add-on.
- **Seguridad:** Retell firma los webhooks con la API key (`x-retell-signature`) y ninguna llave va en las URL. Las funciones llevan el encabezado `X-Bukeame-Voz`. El negocio sale siempre de la llamada que aceptó el webhook firmado, nunca de lo que diga la IA.

Archivos:
- `backend/module-voz.js`: rutas, minutos y líneas.
- `backend/retell-plantilla.js`: el prompt, las funciones y el script que crea o actualiza el agente.
- `frontend/recepcionista.html`: la página del dueño.
- `database/35-schema-recepcionista-ia.sql`: la migración.

---

## 1. Lo que hace Wifnix una sola vez

Entra primero: `ssh deploy@2.24.70.107` (sigue solo cuando diga `deploy@srv1642403:~$`). Corre un comando a la vez.

**a) Cuenta de Retell.** Ábrela en <https://www.retellai.com> con la tarjeta de Wifnix. En **Settings → API Keys** copia la llave que tiene la etiqueta **webhook** al lado. Tiene que ser esa: con ella se verifican las firmas, y con otra llave se rechazan todas las llamadas.

**b) Bajar el código y crear las tablas:**

```bash
cd /var/www/bukeame && git pull origin main
```

```bash
sudo -u postgres psql -d bukeame -f /var/www/bukeame/database/35-schema-recepcionista-ia.sql
```

**c) Poner las llaves en el `.env`.** La de Retell se pega sin que se vea ni quede en el historial:

```bash
read -rsp 'Pega la API key de Retell y oprime Enter: ' K && printf '\nRETELL_API_KEY=%s\n' "$K" >> /var/www/bukeame/backend/.env && unset K && echo ' guardada' 1>&2
```

```bash
cd /var/www/bukeame/backend && (grep -q '^RETELL_VOZ_KEY=' .env || printf '\nRETELL_VOZ_KEY=%s\n' "$(openssl rand -hex 24)" >> .env) && grep -cE '^RETELL_(API|VOZ)_KEY=' .env 1>&2
```

El último comando debe imprimir `2`.

**d) Escoger las voces.** Este comando lista las voces de la cuenta:

```bash
cd /var/www/bukeame/backend && node retell-plantilla.js --voces
```

Escucha unas cuantas en el dashboard de Retell (**Voices**) y quédate con 3 o 4 que suenen bien en español. Luego ponlas en el `.env`, cambiando los `id` por los de verdad. La primera es la que se usa si el negocio no escoge:

```bash
cd /var/www/bukeame/backend && printf '\nRETELL_VOZ_DEFAULT=%s\nRETELL_VOCES=%s\n' 'id1' 'id1|Mujer cálida,id2|Hombre joven,id3|Mujer seria' >> .env && grep -E '^RETELL_VO' .env 1>&2
```

**e) Crear el agente plantilla.** La primera vez lo crea y guarda `RETELL_AGENT_ID` en el `.env`:

```bash
cd /var/www/bukeame/backend && node retell-plantilla.js
```

**f) Reiniciar:**

```bash
cd /var/www/bukeame/backend && node --check server.js && pm2 restart bukeame-api
```

**g) Probar con Los Pelaos:**
1. Desde el panel de admin, dale a Los Pelaos el add-on **Recepcionista IA**.
2. En el panel del negocio, ve a **Recepcionista IA** y toca **Activar mi línea**. Sale el número nuevo.
3. Marca los códigos de desvío que salen ahí, en el celular del negocio.
4. Llama al negocio desde otro teléfono y no contestes.

En **Llamadas** debe salir la llamada con su resumen y su grabación.

Si en esa prueba la llamada se cuelga sola y en **Call History** de Retell no hay agente, Retell exige un agente fijo en el número. En ese caso:
1. Pon `VOZ_AGENTE_EN_NUMERO=1` en el `.env`.
2. Corre `node retell-plantilla.js --numeros` (le pone el agente a los números ya comprados).
3. Reinicia.

Así se pierde el "falla cerrado" solo cuando el servidor esté caído; el webhook sigue rechazando a quien no tenga el add-on.

---

## 2. Lo que hace cada negocio (en su panel → Recepcionista IA)

- **Activar mi línea:** le da su número (787 si hay, si no 939, si no cualquiera de EE. UU.).
- **Desvío:** la página le enseña los códigos ya escritos con su número, con botón de copiar:
  - no contesta en 20 s: `**61*`
  - ocupado: `**67*`
  - apagado: `**62*`
  - quitar todo: `##002#`
- **Cómo contesta:**
  - la voz, con muestra para escuchar;
  - el saludo (el aviso de IA y grabación va siempre);
  - qué puede hacer: reservar y tomar mensajes, o solo tomar mensajes;
  - un número para pasarle la llamada a una persona (no deja poner el del negocio, porque daría vueltas);
  - los apodos de sus servicios;
  - hasta 12 preguntas frecuentes con su respuesta.
- **Minutos:** los usados de los 150 del periodo pagado y cuándo se renuevan.
- **Llamadas:** las últimas 50, con quién llamó, cuánto duró, si terminó en cita, mensaje o pasada a una persona, el resumen y la grabación.

Al dueño le llegan por WhatsApp:
- "Nueva cita" (como siempre);
- los mensajes que toma la IA;
- el aviso al 80 % y al 100 % de los minutos;
- el aviso de pausa si vence el add-on.

---

## 3. Reglas que protegen el costo

- **Los minutos son del periodo pagado del add-on** (bloques de 30 días desde que se paga), no del mes calendario. Renovar antes de tiempo no regala minutos. Una llamada en curso cuenta como 10 minutos hasta que termina.
- **Al llegar a 150 minutos:** solo toma mensajes, con llamadas de 2 minutos como máximo, y avisa al dueño (también avisa al 80 %).
- **Al llegar a 225 minutos (1.5 veces el tope):** la línea deja de contestar hasta que se renueve.
- **Llamadas a la vez:** 3 como máximo por negocio (`VOZ_MAX_SIMULTANEAS`). Un mismo número no puede llamar más de 6 veces en una hora.
- **Por llamada:** hasta 2 citas y 2 mensajes. Los enlaces que dicte quien llama no salen en el WhatsApp (anti-phishing).
- **Pasar la llamada a una persona:** solo a números de PR o EE. UU. (no 900/976 ni países del Caribe que usan el +1).
- **Si vence el add-on:** la línea no contesta y queda en pausa.
  - Si renueva, vuelve con el mismo número.
  - A los 30 días en pausa, el número se le devuelve a Retell (deja de costar $2/mes).
- **Duración máxima de una llamada normal:** 10 minutos. Se cuelga tras 20 segundos de silencio.

Para cambiar los minutos de un negocio en particular:

```sql
UPDATE voice_lines SET minutes_included = 300 WHERE business_id = '<id>';
```

---

## 4. Cambiar el prompt o las funciones

Se cambian en `backend/retell-plantilla.js`. Después, en el servidor, se corre otra vez el script (con `RETELL_AGENT_ID` ya en el `.env`, actualiza en vez de crear):

```bash
cd /var/www/bukeame && git pull origin main && cd backend && node retell-plantilla.js
```

Lo que cambie en `module-voz.js` necesita `pm2 restart bukeame-api`.

---

## 5. Si algo falla

- **La llamada no la contesta nadie:** revisa en el panel que la línea diga activa y que el add-on esté pagado. En el dashboard de Retell, **Call History** dice por qué se colgó.
- **Retell rechaza las llamadas por los ajustes de voz o palabras clave:** pon `VOZ_OVERRIDE=0` en el `.env` y reinicia. Así se usa la voz de la plantilla para todos.
- **Todas las llamadas se rechazan y en los logs sale "firma de Retell inválida":** `RETELL_API_KEY` no es la llave con la etiqueta webhook. Cámbiala en el `.env` y reinicia.
- **Errores:** `pm2 logs bukeame-api --lines 100 | grep voz`.
- **Versiones de Retell:** el script actualiza la versión más reciente del agente. Si en el dashboard sale que hay que **publicar**, publícalo desde ahí.

## Variables del `.env`

| Variable | Para qué |
|---|---|
| `RETELL_API_KEY` | API de Retell (comprar números, voces, grabaciones) y verificar firmas (la de la etiqueta webhook) |
| `RETELL_VOZ_KEY` | Llave propia: va en el encabezado de las funciones de la plantilla |
| `RETELL_AGENT_ID` | El agente plantilla (lo escribe el script) |
| `RETELL_VOCES` | Voces que el dueño puede escoger: `id\|Etiqueta,id\|Etiqueta` |
| `RETELL_VOZ_DEFAULT` | Voz de la plantilla |
| `RETELL_MODELO` | Modelo de IA (por defecto `gpt-4.1`) |
| `VOZ_AREAS` | Códigos de área a intentar al comprar (por defecto `787,939`) |
| `VOZ_OVERRIDE` | `0` apaga la voz y las palabras clave por negocio |
| `VOZ_MAX_SIMULTANEAS` | Llamadas a la vez por negocio (por defecto 3) |
| `VOZ_AGENTE_EN_NUMERO` | `1` = los números llevan el agente fijo (solo si Retell lo exige) |
