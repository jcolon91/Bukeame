// ============================================================================
//  BUKEAME — plantilla del agente de la RECEPCIONISTA IA en Retell
// ----------------------------------------------------------------------------
//  Un solo agente sirve a TODOS los negocios. Cuando entra una llamada, Retell le
//  pregunta a Bukéame (/api/voz/entrante) de qué negocio es el número, y Bukéame le
//  devuelve las variables de ese negocio ({{negocio_nombre}}, {{preguntas_frecuentes}}…).
//  Las 4 funciones (/api/voz/fn/…) saben de qué negocio es por la llamada misma.
//
//  Correr en el servidor (crea el agente la primera vez; después lo ACTUALIZA):
//    cd /var/www/bukeame/backend && node retell-plantilla.js
//  Ver las voces de la cuenta para escoger las del panel:
//    cd /var/www/bukeame/backend && node retell-plantilla.js --voces
//  Repasar los números ya comprados (webhook de entrada y, con VOZ_AGENTE_EN_NUMERO=1,
//  el agente fijo por si Retell lo exigiera):
//    cd /var/www/bukeame/backend && node retell-plantilla.js --numeros
//
//  Lee del .env: RETELL_API_KEY, RETELL_VOZ_KEY y (si ya existe) RETELL_AGENT_ID.
//  Opcionales: RETELL_VOZ_DEFAULT (voz de la plantilla), RETELL_MODELO, VOZ_BASE_URL.
//  La primera vez escribe RETELL_AGENT_ID en el .env. Después hay que reiniciar el API.
// ============================================================================

const SITE = process.env.VOZ_BASE_URL || 'https://bukeame.com';

const PROMPT = `## Quién eres
Eres la recepcionista virtual de {{negocio_nombre}}, {{negocio_tipo}} en {{negocio_pueblo}}, Puerto Rico. Contestas las llamadas que el equipo no puede coger porque está atendiendo clientes. Eres una inteligencia artificial; si te preguntan, lo dices sin rodeos.

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

## Lo que este negocio quiere que sepas
Cómo hablan sus clientes: {{vocabulario}}
Apodos de sus servicios: {{apodos}}
Preguntas frecuentes (contéstalas como dicen aquí):
{{preguntas_frecuentes}}
{{aviso_limite}}

## Qué puedes hacer en esta llamada
Modo: {{modo}}.
- "reservar": das información, buscas horas y haces citas.
- "solo_mensajes": das información y tomas mensajes, pero NO haces citas. Si quieren una cita, toma el mensaje con dejar_mensaje y dile que el negocio lo llama para darle el turno.

## De dónde sale la información
- Antes de hablar de servicios, precios, depósito, barberos o empleados, horario o dirección, llama a info_negocio (una vez por llamada, sin anunciarlo).
- Nunca inventes horas, precios, servicios, promociones ni políticas. Lo que no venga de las funciones ni de las preguntas frecuentes, no lo sabes.
- Si preguntan algo que no sabes, ofrece dejarle el mensaje al negocio con dejar_mensaje.

## Para hacer una cita (solo en modo "reservar")
1. Pregunta qué servicio quiere. Si lo dice a su manera, usa los apodos y el vocabulario de arriba para escoger el servicio de la lista; si hay duda entre dos, pregunta.
2. Si hay más de una persona en el equipo, pregunta si quiere a alguien en específico o al primero que esté disponible.
3. Pregunta el día y si prefiere mañana, tarde o una hora en particular.
4. Llama a buscar_horas. Ofrece como máximo tres horas de las que vengan, no las leas todas. Si no hay, ofrece otro día.
5. Cuando escoja la hora, pide su nombre y confirma su WhatsApp. El número desde el que llama es {{user_number}}: léelo en grupos y pregunta si ahí le llega el WhatsApp. Si dice que no, o si no hay número, pide uno de diez dígitos.
6. Si el servicio lleva depósito, avísale antes de reservar: "Ese servicio lleva un depósito de [cantidad] para separar el turno; te llega el enlace para pagarlo por WhatsApp."
7. Repite en una sola frase el servicio, el día, la hora y la persona (si escogió una), y espera que te diga que sí.
8. Llama a reservar_cita con el service_id, el start_iso EXACTO de la hora escogida (cópialo tal cual de buscar_horas), el nombre, el teléfono y, si escogió a alguien, su staff_id.
9. Si sale bien, dile lo que viene en decir_al_cliente junto con el día y la hora. No hace falta deletrear el código.
   Si sale un error, explícale con lo que diga el error y, si el turno se ocupó, vuelve a buscar_horas y ofrece otra hora.

## Cancelar o cambiar una cita
No puedes cancelar ni mover citas. Explícale que lo puede hacer desde el enlace del WhatsApp de confirmación, o que le dejas el mensaje al negocio con dejar_mensaje.

## Hablar con una persona
Si quiere hablar con una persona, tiene una queja o necesita algo que no puedes resolver:
- Si "{{puede_transferir}}" es "sí", dile que lo vas a pasar y usa pasar_a_persona.
- Si es "no", pide su nombre y su número, resume en una frase lo que necesita y llama a dejar_mensaje. Dile que el equipo lo llama o le escribe.

## Reglas
- Solo pides nombre y teléfono. Nunca pidas tarjetas, pagos, contraseñas, direcciones ni otros datos.
- No hables de otros negocios ni des consejos médicos.
- Si es una llamada de ventas, una broma o te tratan mal, despídete con cortesía y cuelga.

## Cerrar
Cuando todo esté listo, despídete corto ("¡Gracias por llamar a {{negocio_nombre}}, que tengas buen día!") y usa end_call.`;

// Si el webhook de entrada fallara, Retell conecta la llamada igual: estas variables
// evitan que la IA diga "{{negocio_nombre}}" en voz alta. Las funciones igual
// encuentran el negocio por el número al que llamaron.
const DEFAULTS = {
  negocio_nombre: 'el negocio', negocio_tipo: 'un negocio', negocio_pueblo: 'Puerto Rico',
  vocabulario: 'No hay.', apodos: 'No hay.', preguntas_frecuentes: 'No hay.', aviso_limite: '',
  modo: 'solo_mensajes', puede_transferir: 'no', transfer_number: '',
  saludo_inicial: 'Gracias por llamar. Te atiende la recepcionista virtual, que es una inteligencia artificial, y esta llamada se graba para darte un mejor servicio. ¿En qué te puedo ayudar?',
};

function plantilla({ vozKey }) {
  const fn = (name, description, parameters, extra = {}) => ({
    type: 'custom', name, description,
    url: `${SITE}/api/voz/fn/${name}`, method: 'POST',
    headers: { 'X-Bukeame-Voz': vozKey },
    parameters, args_at_root: false, timeout_ms: 15000,
    speak_after_execution: true, speak_during_execution: false, ...extra,
  });
  const esperando = (texto) => ({
    speak_during_execution: true, execution_message_type: 'static_text', execution_message_description: texto,
  });
  const tools = [
    fn('info_negocio',
      'Trae los servicios con su id, duración, precio y depósito, el equipo con su id, el horario de cada día, la dirección y la política de cancelación del negocio. Llámala una vez antes de hablar de servicios, precios, equipo u horario.',
      { type: 'object', properties: {} }),
    fn('buscar_horas',
      'Busca las horas libres de un día para un servicio. Devuelve pocas horas ya dichas en hora de Puerto Rico, cada una con su start_iso. Úsala cuando el cliente diga qué servicio y qué día quiere.',
      {
        type: 'object',
        properties: {
          service_id: { type: 'string', description: 'El id del servicio, tal como viene en info_negocio.' },
          fecha: { type: 'string', description: 'El día en formato AAAA-MM-DD, según el calendario de Puerto Rico.' },
          staff_id: { type: 'string', description: 'El id de la persona del equipo si el cliente escogió a alguien. Si quiere el primero disponible, no lo mandes.' },
          parte_del_dia: { type: 'string', enum: ['mañana', 'tarde', 'noche'], description: 'Si el cliente prefiere la mañana, la tarde o la noche.' },
          hora_preferida: { type: 'string', description: 'Si pidió una hora específica, en formato de 24 horas HH:MM (por ejemplo 15:30 para las tres y media de la tarde).' },
        },
        required: ['service_id', 'fecha'],
      }, esperando('Déjame ver qué hay disponible.')),
    fn('reservar_cita',
      'Reserva la cita. Llámala solo después de que el cliente confirme el servicio, el día, la hora, su nombre y su WhatsApp. Devuelve decir_al_cliente con lo que hay que decirle.',
      {
        type: 'object',
        properties: {
          service_id: { type: 'string', description: 'El id del servicio escogido.' },
          start_iso: { type: 'string', description: 'El start_iso EXACTO de la hora escogida, copiado tal cual de buscar_horas.' },
          nombre: { type: 'string', description: 'Nombre y apellido del cliente.' },
          telefono: { type: 'string', description: 'El WhatsApp del cliente, 10 dígitos.' },
          staff_id: { type: 'string', description: 'El id de la persona del equipo si el cliente escogió a alguien.' },
          nota: { type: 'string', description: 'Algo que el cliente quiera que el negocio sepa. Opcional.' },
        },
        required: ['service_id', 'start_iso', 'nombre', 'telefono'],
      }, esperando('Dame un segundito, te la estoy separando.')),
    fn('dejar_mensaje',
      'Le manda un mensaje al dueño del negocio por WhatsApp. Úsala cuando el cliente quiera hablar con una persona y no se pueda pasar la llamada, tenga una queja, quiera cancelar o cambiar una cita, quiera cita en modo solo_mensajes, o pregunte algo que no sabes.',
      {
        type: 'object',
        properties: {
          nombre: { type: 'string', description: 'Nombre del cliente.' },
          telefono: { type: 'string', description: 'Número del cliente para devolverle la llamada, 10 dígitos.' },
          mensaje: { type: 'string', description: 'Lo que necesita, resumido en una o dos frases.' },
        },
        required: ['mensaje'],
      }),
    {
      type: 'transfer_call', name: 'pasar_a_persona',
      description: 'Pasa la llamada a una persona del negocio. Úsala SOLO si puede_transferir es "sí" y el cliente pidió hablar con alguien o necesita algo que no puedes resolver.',
      transfer_destination: { type: 'predefined', number: '{{transfer_number}}' },
      transfer_option: { type: 'cold_transfer', show_transferee_as_caller: true },
    },
    { type: 'end_call', name: 'end_call', description: 'Cuelga cuando la conversación terminó y ya te despediste.' },
  ];
  const llm = {
    general_prompt: PROMPT,
    begin_message: '{{saludo_inicial}}',
    start_speaker: 'agent',
    default_dynamic_variables: DEFAULTS,
    model_config: { type: 'cascading', primary: { model: process.env.RETELL_MODELO || 'gpt-4.1' }, temperature: 0 },
    general_tools: tools,
  };
  const agent = {
    agent_name: 'Bukéame — recepcionista IA (plantilla)',
    language: 'es-419',
    webhook_url: `${SITE}/api/voz/eventos`,   // Retell lo firma con la API key (x-retell-signature)
    webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
    max_call_duration_ms: 600000,          // 10 minutos por llamada como máximo
    end_call_after_silence_ms: 20000,
    boosted_keywords: ['Bukéame'],
    data_storage_setting: 'everything',    // grabación y transcripción para el panel del negocio
    post_call_analysis_data: [{
      type: 'string', name: 'resumen',
      description: 'Resumen en español, de una o dos frases, de lo que quería el cliente y cómo terminó la llamada.',
    }],
  };
  return { llm, agent };
}

module.exports = { plantilla, PROMPT, DEFAULTS };

// ---------------------------------------------------------------------------
//  Uso como script
// ---------------------------------------------------------------------------
if (require.main === module) {
  require('dotenv').config();
  const fs = require('fs');
  const path = require('path');
  const API = process.env.RETELL_API_BASE || 'https://api.retellai.com';
  const key = process.env.RETELL_API_KEY;
  const vozKey = process.env.RETELL_VOZ_KEY;
  const say = (...a) => console.error(...a);   // a stderr: la terminal del servidor solo muestra stderr
  const call = async (method, p, body) => {
    const r = await fetch(API + p, {
      method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
    });
    let data = null; try { data = await r.json(); } catch (_e) {}
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(data).slice(0, 400)}`);
    return data;
  };
  (async () => {
    if (!key || !vozKey) { say('Falta RETELL_API_KEY o RETELL_VOZ_KEY en el .env.'); process.exit(1); }
    if (process.argv.includes('--voces')) {
      const vs = await call('GET', '/list-voices');
      for (const v of vs) say(`${v.voice_id}\t${v.voice_name}\t${v.provider}\t${v.gender}\t${v.accent || ''}`);
      say(`\n${vs.length} voces. Escoge 3 o 4 que hablen bien español y ponlas en el .env así:`);
      say('RETELL_VOCES=id1|Mujer cálida,id2|Hombre joven,id3|Mujer seria');
      return;
    }
    if (process.argv.includes('--numeros')) {
      const nums = (await call('GET', '/list-phone-numbers')).filter((n) => String(n.nickname || '').startsWith('bukeame-'));
      const conAgente = process.env.VOZ_AGENTE_EN_NUMERO === '1' && process.env.RETELL_AGENT_ID;
      for (const n of nums) {
        const cambio = { inbound_webhook_url: `${SITE}/api/voz/entrante` };
        if (conAgente) cambio.inbound_agents = [{ agent_id: process.env.RETELL_AGENT_ID, weight: 1 }];
        await call('PATCH', `/update-phone-number/${encodeURIComponent(n.phone_number)}`, cambio);
        say(`${n.phone_number}  ${n.nickname}  listo${conAgente ? ' (con agente fijo)' : ''}`);
      }
      say(`${nums.length} números de Bukéame repasados.`);
      return;
    }
    const { llm, agent } = plantilla({ vozKey });
    let agentId = process.env.RETELL_AGENT_ID;
    if (agentId) {
      const cur = await call('GET', `/get-agent/${agentId}`);
      const llmId = cur.response_engine && cur.response_engine.llm_id;
      if (!llmId) throw new Error('El agente no usa un Retell LLM; no lo puedo actualizar.');
      await call('PATCH', `/update-retell-llm/${llmId}`, llm);
      const voice = process.env.RETELL_VOZ_DEFAULT;
      await call('PATCH', `/update-agent/${agentId}`, voice ? { ...agent, voice_id: voice } : agent);
      say(`Listo: plantilla actualizada (agente ${agentId}, LLM ${llmId}).`);
    } else {
      const voice = process.env.RETELL_VOZ_DEFAULT || (String(process.env.RETELL_VOCES || '').split(',')[0] || '').split('|')[0];
      if (!voice) { say('Falta la voz: corre primero con --voces y pon RETELL_VOZ_DEFAULT=<voice_id> en el .env.'); process.exit(1); }
      const l = await call('POST', '/create-retell-llm', llm);
      const a = await call('POST', '/create-agent', { ...agent, voice_id: voice, response_engine: { type: 'retell-llm', llm_id: l.llm_id } });
      agentId = a.agent_id;
      const envPath = path.join(__dirname, '.env');
      fs.appendFileSync(envPath, `\nRETELL_AGENT_ID=${agentId}\n`);
      say(`Listo: agente creado (${agentId}) y guardado en el .env. Reinicia el API: pm2 restart bukeame-api`);
    }
  })().catch((e) => { say('ERROR:', e.message); process.exit(1); });
}
