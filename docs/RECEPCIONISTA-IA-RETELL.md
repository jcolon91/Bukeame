# Recepcionista IA por teléfono (Retell) — Los Pelaos

Cuando nadie coge el teléfono de la barbería, la llamada pasa a una recepcionista con IA (Retell). Esta recepcionista:

- contesta en español de PR,
- dice los servicios y precios,
- busca horas libres en Bukéame y reserva la cita.

El cliente recibe el mismo WhatsApp de confirmación (o de depósito) que si hubiera reservado en la web, y el dueño recibe el aviso de "Nueva cita". Lo que la IA no sabe resolver se lo deja al dueño como mensaje por WhatsApp.

La IA **no** cancela ni mueve citas, **no** cobra y **no** inventa horas ni precios: todo sale de Bukéame en el momento.

**Piezas:**
- `backend/module-voz.js` — 4 rutas que Retell llama durante la llamada:
  - `POST /api/voz/:slug/servicios`
  - `POST /api/voz/:slug/horas`
  - `POST /api/voz/:slug/reservar`
  - `POST /api/voz/:slug/mensaje`

  Por dentro usan las mismas rutas públicas de la web, con las mismas validaciones, depósitos y avisos.
- Seguridad: cada pedido trae el encabezado `X-Bukeame-Voz` con la llave del `.env`, y solo funcionan los negocios que estén en `VOZ_SLUGS`. Sin la llave en el `.env`, las rutas responden "no activada".

---

## 1. Servidor (una vez)

Entra primero: `ssh deploy@2.24.70.107` (sigue solo cuando diga `deploy@srv1642403:~$`).

**a) Bajar el código:**

```bash
cd /var/www/bukeame && git pull origin main
```

**b) Crear la llave y activar Los Pelaos.** Si ya existe, no la cambia; en los dos casos la imprime:

```bash
cd /var/www/bukeame/backend && (grep -q '^RETELL_VOZ_KEY=' .env || printf '\nRETELL_VOZ_KEY=%s\nVOZ_SLUGS=los-pelaos\n' "$(openssl rand -hex 24)" >> .env) && grep -E '^(RETELL_VOZ_KEY|VOZ_SLUGS)=' .env 1>&2
```

Copia el valor de `RETELL_VOZ_KEY` (lo que va después del `=`). Ese valor va en Retell, en el encabezado de cada función, y no se comparte con nadie más.

**c) Reiniciar:**

```bash
cd /var/www/bukeame/backend && node --check server.js && pm2 restart bukeame-api
```

**d) Probar que contesta.** Debe salir el nombre del negocio, los servicios y los barberos:

```bash
cd /var/www/bukeame/backend && curl -s -X POST https://bukeame.com/api/voz/los-pelaos/servicios -H "Content-Type: application/json" -H "X-Bukeame-Voz: $(grep '^RETELL_VOZ_KEY=' .env | cut -d= -f2-)" -d '{}' 1>&2
```

---

## 2. Crear el agente en Retell

1. Entra a <https://www.retellai.com> y crea la cuenta (la tarjeta la pones tú).
2. Ve a **Agents** → **Create an agent** → **Single Prompt**. Ponle de nombre `Los Pelaos — recepcionista`.
3. En el agente, ajusta lo siguiente:
   - **Language:** Spanish (Latin America) si aparece; si no, Spanish.
   - **Voice:** escoge una voz en español latino. Prueba 2 o 3 con el botón de muestra y quédate con la que suene más natural.
   - **LLM / modelo:** deja el que trae por defecto. No escojas uno "mini" o "nano": se equivocan más con fechas y horas.
4. Pega el **prompt** de la sección 3 en el cuadro grande del prompt.
5. Pega el **mensaje de bienvenida** (Begin message / Welcome message) de la sección 4.
6. Añade las **5 funciones** de la sección 5.
7. Opcional, en **Speech settings → Boosted keywords:** `Los Pelaos, Carlos, JC, Kevin, Diana, Bukéame, Caguas`. Esto ayuda a que entienda bien los nombres.

---

## 3. Prompt (pegar completo)

```text
## Quién eres
Eres la recepcionista virtual de Los Pelaos, una barbería en Caguas, Puerto Rico. Contestas las llamadas que el equipo no puede coger porque está atendiendo clientes. Eres una inteligencia artificial; si te preguntan, lo dices sin rodeos.

## Cómo hablas
- Español de Puerto Rico, cálido y al grano. Tuteas con respeto.
- Frases cortas y una pregunta a la vez. Es una llamada, no un chat: nada de listas, símbolos, enlaces ni códigos largos.
- Las horas dilas habladas ("las diez y media de la mañana") y los precios en palabras ("quince dólares").
- Si el cliente habla inglés, sigue en inglés.

## Fecha y hora de hoy (Puerto Rico)
Ahora: {{current_time_America/Puerto_Rico}}
Próximos días:
{{current_calendar_America/Puerto_Rico}}
Usa esto para convertir "mañana", "el sábado" o "el 3" en una fecha AAAA-MM-DD. Nunca adivines la fecha; si no estás segura, pregunta.

## De dónde sale la información
- Antes de hablar de servicios, precios, barberos, horario, dirección o depósito, llama a ver_servicios (una vez por llamada, sin anunciarlo).
- Nunca inventes horas, precios, servicios, promociones ni políticas. Lo que no venga de las funciones, no lo sabes.
- Si preguntan algo que no sabes (precio especial, si atienden niños, estacionamiento, productos), ofrece dejarle el mensaje al negocio con dejar_mensaje.

## Para hacer una cita
1. Pregunta qué servicio quiere. Si lo dice a su manera ("un recorte", "un fade", "pelarme"), escoge el servicio que corresponde de la lista; si hay duda entre dos, pregunta.
2. Pregunta si quiere un barbero en específico o el primero que esté disponible.
3. Pregunta el día y si prefiere mañana, tarde o una hora en particular.
4. Llama a buscar_horas. Ofrece como máximo tres horas de las que vengan, no las leas todas. Si no hay, ofrece otro día.
5. Cuando escoja la hora, pide su nombre y confirma su WhatsApp. El número desde el que llama es {{user_number}}: léelo en grupos y pregunta si ahí le llega el WhatsApp. Si dice que no, o si no hay número, pide uno de diez dígitos.
6. Si el servicio lleva depósito, avísale antes de reservar: "Ese servicio lleva un depósito de [cantidad] para separar el turno; te llega el enlace para pagarlo por WhatsApp."
7. Repite en una sola frase el servicio, el día, la hora y el barbero (si escogió uno), y espera que te diga que sí.
8. Llama a reservar_cita con el service_id, el start_iso EXACTO de la hora escogida (cópialo tal cual de buscar_horas), el nombre, el teléfono y, si escogió barbero, su staff_id.
9. Si sale bien, dile lo que viene en decir_al_cliente junto con el día y la hora. No hace falta deletrear el código.
   Si sale un error, dile que ese turno se acaba de ocupar, vuelve a buscar_horas y ofrece otra hora.

## Cancelar o cambiar una cita
No puedes cancelar ni mover citas. Explícale que lo puede hacer desde el enlace del WhatsApp de confirmación, o que le dejas el mensaje al negocio con dejar_mensaje.

## Dejar un mensaje
Si quiere hablar con una persona, tiene una queja o una pregunta que no sabes contestar: pide su nombre y su número, resume en una frase lo que necesita y llama a dejar_mensaje. Dile que el equipo lo llama o le escribe.

## Reglas
- Solo pides nombre y teléfono. Nunca pidas tarjetas, pagos, contraseñas, direcciones ni otros datos.
- No hables de otros negocios ni des consejos médicos.
- Si es una llamada de ventas, una broma o te tratan mal, despídete con cortesía y cuelga.

## Cerrar
Cuando todo esté listo, despídete corto ("¡Gracias por llamar a Los Pelaos, que tengas buen día!") y usa end_call.
```

---

## 4. Mensaje de bienvenida (Begin message)

```text
Gracias por llamar a Los Pelaos. Te atiende la recepcionista virtual, que es una inteligencia artificial, y esta llamada se graba para darte un mejor servicio. ¿En qué te puedo ayudar?
```

El aviso de "inteligencia artificial" y de grabación va al principio a propósito: en PR la grabación necesita el consentimiento de las dos partes. No lo quites.

---

## 5. Funciones

En el agente: **Functions** → **+ Add** → **Custom Function** (una por cada una de las 4 de abajo). La quinta es la de colgar.

**Lo mismo en las 4:**
- **Method:** `POST`
- **Headers:** una fila con Key `X-Bukeame-Voz` y Value = la llave del paso 1b.
- **Payload: args only:** **ENCENDIDO**. Sin esto, Bukéame no ve los datos.
- **Timeout (ms):** `15000`
- **Speak after execution / Talk after action completed:** encendido (como viene).
- **Parameters:** pega el JSON de cada una en el editor de JSON.

### 5.1 `ver_servicios`

- **Name:** `ver_servicios`
- **Description:** `Trae los servicios con su id, duración, precio y depósito, los barberos con su id, el horario de cada día, la dirección y la política de cancelación de Los Pelaos. Llámala una vez antes de hablar de servicios, precios, barberos u horario.`
- **URL:** `https://bukeame.com/api/voz/los-pelaos/servicios`
- **Speak during execution / Talk while waiting:** apagado.
- **Parameters:**

```json
{
  "type": "object",
  "properties": {}
}
```

### 5.2 `buscar_horas`

- **Name:** `buscar_horas`
- **Description:** `Busca las horas libres de un día para un servicio. Devuelve pocas horas ya dichas en hora de Puerto Rico, cada una con su start_iso. Úsala cuando el cliente diga qué servicio y qué día quiere.`
- **URL:** `https://bukeame.com/api/voz/los-pelaos/horas`
- **Speak during execution / Talk while waiting:** Static sentence → `Déjame ver qué hay disponible.`
- **Parameters:**

```json
{
  "type": "object",
  "properties": {
    "service_id": { "type": "string", "description": "El id del servicio, tal como viene en ver_servicios." },
    "fecha": { "type": "string", "description": "El día en formato AAAA-MM-DD, según el calendario de Puerto Rico." },
    "staff_id": { "type": "string", "description": "El id del barbero si el cliente escogió uno. Si quiere el primero disponible, no lo mandes." },
    "parte_del_dia": { "type": "string", "enum": ["mañana", "tarde", "noche"], "description": "Si el cliente prefiere la mañana, la tarde o la noche." },
    "hora_preferida": { "type": "string", "description": "Si pidió una hora específica, en formato de 24 horas HH:MM (por ejemplo 15:30 para las tres y media de la tarde)." }
  },
  "required": ["service_id", "fecha"]
}
```

### 5.3 `reservar_cita`

- **Name:** `reservar_cita`
- **Description:** `Reserva la cita en Bukéame. Llámala solo después de que el cliente confirme el servicio, el día, la hora, su nombre y su WhatsApp. Devuelve decir_al_cliente con lo que hay que decirle.`
- **URL:** `https://bukeame.com/api/voz/los-pelaos/reservar`
- **Speak during execution / Talk while waiting:** Static sentence → `Dame un segundito, te la estoy separando.`
- **Parameters:**

```json
{
  "type": "object",
  "properties": {
    "service_id": { "type": "string", "description": "El id del servicio escogido." },
    "start_iso": { "type": "string", "description": "El start_iso EXACTO de la hora escogida, copiado tal cual de buscar_horas." },
    "nombre": { "type": "string", "description": "Nombre y apellido del cliente." },
    "telefono": { "type": "string", "description": "El WhatsApp del cliente, 10 dígitos." },
    "staff_id": { "type": "string", "description": "El id del barbero si el cliente escogió uno." },
    "nota": { "type": "string", "description": "Algo que el cliente quiera que el barbero sepa. Opcional." }
  },
  "required": ["service_id", "start_iso", "nombre", "telefono"]
}
```

### 5.4 `dejar_mensaje`

- **Name:** `dejar_mensaje`
- **Description:** `Le manda un mensaje al dueño de Los Pelaos por WhatsApp. Úsala cuando el cliente quiera hablar con una persona, tenga una queja, quiera cancelar o cambiar una cita, o pregunte algo que no sabes.`
- **URL:** `https://bukeame.com/api/voz/los-pelaos/mensaje`
- **Speak during execution / Talk while waiting:** apagado.
- **Parameters:**

```json
{
  "type": "object",
  "properties": {
    "nombre": { "type": "string", "description": "Nombre del cliente." },
    "telefono": { "type": "string", "description": "Número del cliente para devolverle la llamada, 10 dígitos." },
    "mensaje": { "type": "string", "description": "Lo que necesita, resumido en una o dos frases." }
  },
  "required": ["mensaje"]
}
```

### 5.5 Colgar

**+ Add → End Call.** Déjale el nombre `end_call` y de descripción: `Cuelga cuando la conversación terminó y ya te despediste.`

**No añadas "Transfer Call" por ahora.** El teléfono del negocio es el que pasa las llamadas a la IA, así que si la IA transfiere de vuelta a ese mismo número, la llamada da vueltas. Para que hable con una persona, la IA usa `dejar_mensaje`.

---

## 6. Probar antes de conectar el teléfono

En el agente, usa el botón **Test** (llamada desde el navegador) y haz de cliente. Prueba esto:

1. "Quiero un corte mañana por la tarde": debe ofrecer horas reales y avisar del depósito de $5.
2. Reserva una: te llega el WhatsApp con el enlace del depósito y al panel le entra la cita con la nota "Reservada por teléfono (recepcionista IA)".
3. "¿Cuánto cuesta el tinte?": debe decir treinta y cinco dólares.
4. "¿Atienden niños?": debe ofrecer dejar el mensaje, y te llega por WhatsApp.
5. "Quiero cancelar mi cita": debe decir que no puede y ofrecer el enlace o el mensaje.

En la prueba desde el navegador no hay número de quien llama, así que te lo va a pedir. Las citas de prueba con depósito sin pagar se liberan solas a los 30 minutos, o las cancelas desde el panel.

---

## 7. Número y desvío de llamadas

1. **Comprar el número:** en Retell, ve a **Phone Numbers** → **Buy new number**. Pon `787` en el código de área. Si no sale, cualquier número de EE. UU. sirve, porque el cliente nunca lo marca. Cuesta unos $2 al mes.
2. **Conectarlo:** en ese número, en **Inbound call agent**, escoge `Los Pelaos — recepcionista`.
3. **Desvío en el celular del negocio.** Marca el código y oprime llamar, cambiando `NUMERO` por el de Retell (10 dígitos, sin guiones):
   - Si no contesta: `**61*+1NUMERO#`
   - Si está ocupado o rechazas la llamada: `**67*+1NUMERO#`
   - Si está apagado o sin señal: `**62*+1NUMERO#`
   - Para que suene 20 segundos antes de pasar (opcional): `**61*+1NUMERO*11*20#`
   - Para quitarlos todos: `##002#`

   Estos códigos funcionan en Claro, T-Mobile y Liberty (GSM). Si tu plan cobra las llamadas desviadas a EE. UU., confírmalo con tu compañía.
4. **Prueba real:** llama al negocio desde otro teléfono y no contestes.

> **Ojo:** el teléfono de Los Pelaos en Bukéame es el 787-449-2112. Si ese es también tu celular personal, con el desvío **toda** llamada que no cojas (también las personales) la contesta la recepcionista de la barbería. Si eso no te sirve, usa una línea aparte para el negocio o deja solo el desvío de ocupado (`**67*`).

---

## 8. Costo aproximado

- Retell cobra por minuto (voz + IA + línea): **unos $0.09 a $0.14 por minuto**, según la voz y el modelo.
- Una llamada de reservar dura 2 a 3 minutos, o sea **unos $0.20 a $0.40 por llamada**.
- Más **~$2/mes** del número.
- 100 llamadas al mes ≈ $25 a $40.

Bukéame no cobra nada extra por esto.

---

## Mantenimiento

- **Apagarla:** `##002#` en el celular; las llamadas vuelven a ir al buzón.
- **Apagarla del todo en Bukéame:** borra `RETELL_VOZ_KEY` del `.env` y reinicia.
- **Cambiar la llave:** pon un valor nuevo en el `.env`, reinicia y cámbialo en los encabezados de las 4 funciones.
- **Si cambias servicios, precios, barberos u horario en el panel:** no hay que tocar nada. La IA los consulta en cada llamada.
- **Otro negocio:**
  1. Añade su slug en el `.env` separado por coma (`VOZ_SLUGS=los-pelaos,otro-negocio`) y reinicia.
  2. En Retell, duplica el agente y cambia el nombre del negocio en el prompt y en la bienvenida, y `los-pelaos` en las 4 URL.
- **Límite técnico:** todas las llamadas entran a Bukéame desde el mismo servidor, así que comparten el límite de 12 reservas por minuto y 60 consultas por minuto. Para un piloto sobra; con muchos negocios habría que darle a la voz su propio límite.
