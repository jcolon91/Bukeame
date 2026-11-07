// Mudanza: reconocer los archivos que el negocio bajó de su plataforma vieja (Booksy,
// Fresha, GOLDIE, Square, Vagaro…). Todo aquí es puro, sin base de datos: qué fila trae
// los encabezados, qué tipo de archivo es, qué columna es cada cosa y cómo se lee cada
// valor (teléfono, dinero, duración, fecha). module-mudanza.js lo usa para el resumen y
// para mudar; así lo que el negocio ve en el resumen es exactamente lo que se guarda.

const PR_UTC = 4;   // Puerto Rico es UTC-4 todo el año (no cambia la hora)

const sinAcentos = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const clave = (s) => sinAcentos(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
function txt(v, max = 200) {
  if (v == null) return '';
  return String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------- Los tipos de archivo y sus columnas ----------
// Cada campo trae su nombre para el negocio (e) y los encabezados que lo suelen traer (s),
// ya sin acentos, espacios ni signos. El orden de los sinónimos es la preferencia.
const TEL = ['phone', 'mobile', 'mobilephone', 'mobilenumber', 'mobileno', 'cell', 'cellphone', 'cellular',
  'phonenumber', 'phone1', 'primaryphone', 'telephone', 'telefono', 'telefonos', 'numerodetelefono',
  'telefonocelular', 'celular', 'movil', 'tel', 'whatsapp', 'contactnumber', 'clientphone', 'customerphone',
  'clientmobile', 'customermobile', 'clientphonenumber', 'customerphonenumber', 'mobilephonenumber'];
const CORREO = ['email', 'emailaddress', 'correo', 'correoelectronico', 'mail', 'clientemail', 'customeremail',
  'emailaddress1', 'primaryemail'];
const CLIENTE = ['client', 'clientname', 'customer', 'customername', 'cliente', 'nombredelcliente', 'clientfullname',
  'customerfullname', 'guest', 'guestname', 'patient', 'buyer', 'buyername', 'member', 'membername'];
const VENCE = ['expires', 'expiry', 'expirydate', 'expiresat', 'expireson', 'expirationdate', 'expiration',
  'validuntil', 'validto', 'vence', 'vencimiento', 'fechadevencimiento', 'enddate'];
const DURACION = ['duration', 'durationmin', 'durationmins', 'durationminutes', 'durationinminutes', 'minutes',
  'mins', 'minutos', 'duracion', 'duracionmin', 'length', 'servicelength', 'servicetime', 'tiempo'];

const TIPOS = {
  clientes: {
    nombre: 'Clientes',
    campos: {
      full_name: { e: 'Nombre completo', s: ['name', 'fullname', ...CLIENTE, 'nombre', 'nombrecompleto', 'contact', 'contactname', 'displayname'] },
      first_name: { e: 'Nombre', s: ['firstname', 'first', 'givenname', 'primernombre', 'clientfirstname', 'customerfirstname'] },
      last_name: { e: 'Apellido', s: ['lastname', 'last', 'surname', 'familyname', 'apellido', 'apellidos', 'clientlastname', 'customerlastname'] },
      phone: { e: 'Teléfono', s: TEL },
      email: { e: 'Email', s: CORREO },
      notes: { e: 'Notas', s: ['notes', 'note', 'notas', 'nota', 'comments', 'comment', 'comentarios', 'clientnotes', 'customernotes', 'memo', 'alert', 'alerts', 'clientalert'] },
      birthday: { e: 'Cumpleaños', s: ['birthday', 'birthdate', 'dateofbirth', 'dob', 'cumpleanos', 'fechadenacimiento', 'nacimiento'] },
      visits: { e: 'Visitas', s: ['totalvisits', 'visits', 'visitas', 'numberofvisits', 'visitcount', 'totalappointments', 'appointments', 'appointmentcount', 'bookings', 'totalbookings', 'transactioncount', 'completedappointments'] },
      spent: { e: 'Total gastado', s: ['totalspent', 'totalspend', 'totalsales', 'lifetimevalue', 'lifetimespend', 'spent', 'gastado', 'totalgastado', 'sales', 'revenue', 'totalrevenue', 'totalpaid'] },
      last_visit: { e: 'Última visita', s: ['lastvisit', 'lastvisitdate', 'lastappointment', 'lastappointmentdate', 'ultimavisita', 'lastseen', 'lastbooking', 'lastvisited'] },
    },
    requiere: [['phone'], ['full_name', 'first_name', 'last_name']],
  },
  servicios: {
    nombre: 'Servicios',
    campos: {
      name: { e: 'Servicio', s: ['service', 'servicename', 'name', 'servicio', 'nombredelservicio', 'nombre', 'item', 'itemname', 'title', 'treatment', 'treatmentname', 'serviceitem', 'menuitem'] },
      duration: { e: 'Duración', s: [...DURACION, 'time'] },
      price: { e: 'Precio', s: ['price', 'retailprice', 'cost', 'precio', 'costo', 'fullprice', 'pricefrom', 'rate', 'amount', 'servicefee', 'fee', 'priceusd', 'value', 'valor'] },
      description: { e: 'Descripción', s: ['description', 'descripcion', 'details', 'detalle', 'servicedescription', 'about'] },
    },
    requiere: [['name'], ['duration', 'price']],
  },
  citas: {
    nombre: 'Citas',
    campos: {
      datetime: { e: 'Fecha y hora', s: ['startsat', 'starttime', 'startdatetime', 'appointmenttime', 'appointmentdatetime', 'appointmentstart', 'scheduledtime', 'scheduledfor', 'datetime', 'fechayhora', 'start', 'begins', 'startdate'] },
      date: { e: 'Fecha', s: ['date', 'appointmentdate', 'fecha', 'day', 'dia', 'scheduleddate', 'bookingdate', 'appointmentday', 'fechadelacita', 'visitdate'] },
      time: { e: 'Hora', s: ['time', 'hora', 'horadelacita', 'slot', 'appointmenthour'] },
      end: { e: 'Hora de salida', s: ['end', 'endtime', 'endsat', 'enddatetime', 'finish', 'finishtime', 'horafin', 'horadesalida', 'fin'] },
      duration: { e: 'Duración', s: DURACION },
      client_name: { e: 'Cliente', s: [...CLIENTE, 'name', 'fullname', 'nombre'] },
      client_first: { e: 'Nombre del cliente', s: ['firstname', 'clientfirstname', 'customerfirstname', 'first'] },
      client_last: { e: 'Apellido del cliente', s: ['lastname', 'clientlastname', 'customerlastname', 'apellido', 'last'] },
      phone: { e: 'Teléfono', s: TEL },
      email: { e: 'Email', s: CORREO },
      service: { e: 'Servicio', s: ['service', 'services', 'servicename', 'servicio', 'servicios', 'treatment', 'item', 'items', 'appointmenttype', 'type', 'description'] },
      staff: { e: 'Profesional', s: ['staff', 'staffmember', 'staffname', 'employee', 'employeename', 'provider', 'providername', 'teammember', 'team', 'professional', 'profesional', 'empleado', 'empleada', 'barbero', 'barber', 'estilista', 'stylist', 'technician', 'tecnico', 'assignedto', 'resource', 'artist', 'with'] },
      price: { e: 'Precio', s: ['price', 'precio', 'cost', 'total', 'amount', 'monto', 'charge', 'serviceprice', 'value'] },
      // "Payment Status" no es el estado de la cita ("Unpaid" no quiere decir nada de si vino).
      status: { e: 'Estado', s: ['status', 'estado', 'appointmentstatus', 'bookingstatus', 'state'], no: ['pay', 'pago', 'deposit', 'invoice', 'factura'] },
      notes: { e: 'Notas', s: ['notes', 'note', 'notas', 'comments', 'appointmentnotes', 'bookingnotes', 'internalnotes', 'memo'] },
    },
    requiere: [['datetime', 'date'], ['client_name', 'client_first', 'phone', 'email']],
  },
  ventas: {
    nombre: 'Ventas',
    campos: {
      date: { e: 'Fecha', s: ['date', 'saledate', 'fecha', 'createdat', 'created', 'paymentdate', 'paidat', 'transactiondate', 'datetime', 'sold', 'soldat', 'invoicedate', 'fechadeventa', 'day', 'completedat'] },
      amount: { e: 'Total', s: ['total', 'totalsales', 'grandtotal', 'totalcollected', 'collected', 'totalpaid', 'amountpaid', 'paid', 'amount', 'totalamount', 'paymentamount', 'monto', 'montototal', 'totalventa', 'importe', 'sale', 'sales', 'netsales', 'grosssales', 'gross', 'net'] },
      tip: { e: 'Propina', s: ['tip', 'tips', 'gratuity', 'propina', 'propinas', 'tipamount'] },
      tax: { e: 'IVU / impuesto', s: ['tax', 'taxes', 'ivu', 'salestax', 'impuesto', 'impuestos', 'taxamount', 'vat'] },
      description: { e: 'Qué se vendió', s: ['items', 'item', 'itemname', 'description', 'descripcion', 'service', 'services', 'product', 'products', 'concepto', 'detalle', 'details', 'lineitems'] },
      client_name: { e: 'Cliente', s: [...CLIENTE, 'name', 'nombre'] },
      method: { e: 'Forma de pago', s: ['paymentmethod', 'paymentmethods', 'method', 'paymenttype', 'tender', 'tendertype', 'metodo', 'metododepago', 'formadepago', 'pago', 'paidby', 'cardbrand', 'source', 'paymentsource'] },
    },
    requiere: [['date'], ['amount']],
  },
  tarjetas: {
    nombre: 'Tarjetas de regalo',
    campos: {
      code: { e: 'Código', s: ['code', 'giftcardcode', 'giftcard', 'giftcardnumber', 'cardnumber', 'card', 'voucher', 'vouchercode', 'vouchernumber', 'certificate', 'certificatecode', 'codigo', 'numero', 'number', 'serial', 'gan'] },
      balance: { e: 'Saldo', s: ['balance', 'remainingbalance', 'currentbalance', 'remaining', 'amountremaining', 'balanceremaining', 'saldo', 'saldorestante', 'availablebalance', 'valorrestante', 'value'] },
      initial: { e: 'Valor original', s: ['initialvalue', 'initialbalance', 'originalvalue', 'originalamount', 'originalbalance', 'purchaseamount', 'purchasevalue', 'facevalue', 'valorinicial', 'initial', 'loaded', 'amount', 'valor'] },
      purchaser_name: { e: 'Quién la compró', s: ['purchaser', 'purchasername', 'buyer', 'buyername', 'purchasedby', 'comprador', 'from', 'de'] },
      purchaser_email: { e: 'Email de quien la compró', s: ['purchaseremail', 'buyeremail', 'emailcomprador', 'fromemail'] },
      recipient_name: { e: 'Para quién es', s: ['recipient', 'recipientname', 'to', 'para', 'beneficiario', 'client', 'customer', 'clientname', 'customername', 'owner', 'holder'] },
      recipient_email: { e: 'Email de para quién es', s: ['recipientemail', 'toemail', 'email', 'emailaddress', 'correo'] },
      expires: { e: 'Vence', s: VENCE },
    },
    requiere: [['code'], ['balance']],
  },
  paquetes: {
    nombre: 'Paquetes prepagados',
    campos: {
      phone: { e: 'Teléfono', s: TEL },
      email: { e: 'Email', s: CORREO },
      client_name: { e: 'Cliente', s: [...CLIENTE, 'fullname'] },
      name: { e: 'Paquete', s: ['package', 'packagename', 'membership', 'membershipname', 'plan', 'planname', 'paquete', 'membresia', 'series', 'bundle', 'pass', 'passname', 'product', 'productname', 'service', 'name', 'nombre'] },
      remaining: { e: 'Visitas que le quedan', s: ['remaining', 'remainingsessions', 'sessionsremaining', 'sessionsleft', 'visitsremaining', 'visitsleft', 'remainingvisits', 'creditsremaining', 'creditsleft', 'remainingcredits', 'usesleft', 'remaininguses', 'quedan', 'restantes', 'visitasrestantes', 'sesionesrestantes', 'credits', 'balance'] },
      total: { e: 'Visitas en total', s: ['totalsessions', 'sessions', 'totalvisits', 'visits', 'sesiones', 'visitas', 'includedsessions', 'quantity', 'qty', 'uses', 'totaluses', 'total'] },
      expires: { e: 'Vence', s: VENCE },
      price: { e: 'Precio que pagó', s: ['price', 'precio', 'amountpaid', 'pricepaid', 'paid', 'cost', 'valor'] },
    },
    requiere: [['phone', 'email', 'client_name'], ['remaining']],
  },
  lealtad: {
    nombre: 'Puntos de lealtad',
    campos: {
      phone: { e: 'Teléfono', s: TEL },
      email: { e: 'Email', s: CORREO },
      client_name: { e: 'Cliente', s: [...CLIENTE, 'name', 'fullname', 'nombre'] },
      count: { e: 'Puntos o visitas', s: ['points', 'pointsbalance', 'loyaltypoints', 'rewardpoints', 'currentpoints', 'stamps', 'stampcount', 'punches', 'puntos', 'sellos', 'loyaltyvisits', 'visits', 'visitas', 'progress', 'balance'] },
    },
    requiere: [['phone', 'email', 'client_name'], ['count']],
  },
};
const ORDEN_TIPOS = ['tarjetas', 'paquetes', 'lealtad', 'citas', 'ventas', 'servicios', 'clientes'];

// ---------- Encabezados ----------
// Algunos reportes (Vagaro, Square) traen el título del reporte arriba. El encabezado
// es la primera de las 15 filas de arriba que está casi llena y es casi toda texto.
// Una lista hecha a mano a veces no trae encabezados: la primera fila ya es un cliente.
// Si la fila que parece encabezado trae un email o un teléfono, no es encabezado (-1).
const pareceDato = (c) => /@/.test(c) || String(c).replace(/\D/g, '').length >= 7;
function encontrarEncabezado(filas) {
  const arriba = filas.slice(0, 15);
  const llenas = (f) => (Array.isArray(f) ? f : []).map((c) => txt(c, 80)).filter(Boolean);
  const max = Math.max(0, ...arriba.map((f) => llenas(f).length));
  for (let i = 0; i < arriba.length; i++) {
    const l = llenas(arriba[i]);
    const texto = l.filter((c) => !/^[\d\s$.,:/\-()%+]+$/.test(c));
    if (l.length >= 2 && l.length >= Math.ceil(max * 0.6)) {
      if (l.some(pareceDato)) return -1;
      if (texto.length >= l.length * 0.7) return i;
    }
  }
  return 0;
}

function encabezadosUnicos(fila) {
  const vistos = {};
  return fila.map((c, i) => {
    let h = txt(c, 80) || `Columna ${i + 1}`;
    if (vistos[h]) h = `${h} (${++vistos[h]})`; else vistos[h] = 1;
    return h;
  });
}

// ---------- Qué columna es cada cosa ----------
// Primero los encabezados que son exactamente un sinónimo; después los que lo contienen
// ("Client Mobile Phone" contiene "mobilephone"), ganando el sinónimo más largo.
function mapear(tipo, encabezados) {
  const def = TIPOS[tipo];
  const claves = encabezados.map(clave);
  const usados = new Set();
  const mapa = {};
  const vale = (f, k) => !(f.no || []).some((x) => k.includes(x));
  for (const [campo, f] of Object.entries(def.campos)) {
    mapa[campo] = null;
    for (const s of f.s) {
      const i = claves.findIndex((k, j) => !usados.has(j) && k === s && vale(f, k));
      if (i >= 0) { mapa[campo] = encabezados[i]; usados.add(i); break; }
    }
  }
  const candidatos = [];
  for (const [campo, f] of Object.entries(def.campos)) {
    if (mapa[campo]) continue;
    for (const s of f.s) {
      if (s.length < 5) continue;
      claves.forEach((k, j) => { if (!usados.has(j) && k.includes(s) && vale(f, k)) candidatos.push({ campo, j, largo: s.length }); });
    }
  }
  candidatos.sort((a, b) => b.largo - a.largo);
  for (const c of candidatos) {
    if (mapa[c.campo] || usados.has(c.j)) continue;
    mapa[c.campo] = encabezados[c.j]; usados.add(c.j);
  }
  return mapa;
}

const completo = (tipo, mapa) => TIPOS[tipo].requiere.every((g) => g.some((c) => mapa[c]));
const faltan = (tipo, mapa) => TIPOS[tipo].requiere.filter((g) => !g.some((c) => mapa[c]))
  .map((g) => g.map((c) => TIPOS[tipo].campos[c].e).join(' o '));

// Puntos para escoger el tipo: completo pesa más, luego cuántas columnas reconoce y unas
// señales propias (una venta trae propina o IVU; una cita, profesional y estado).
function detectar(encabezados) {
  const mapas = {};
  for (const t of ORDEN_TIPOS) mapas[t] = mapear(t, encabezados);
  const c = mapas.citas;
  const pareceCita = !!((c.datetime || c.date) && (c.service || c.staff));
  const tieneContacto = encabezados.some((h) => TEL.includes(clave(h)) || CORREO.includes(clave(h)));
  const puntos = {};
  for (const t of ORDEN_TIPOS) {
    const m = mapas[t];
    let p = (completo(t, m) ? 100 : 0) + Object.values(m).filter(Boolean).length;
    if (t === 'ventas') {
      if (m.tip || m.tax) p += 4;
      if (m.amount && /total|collected|sales|gross|net|paid/.test(clave(m.amount))) p += 3;
      if (m.method) p += 2;
    }
    if (t === 'citas') {
      if (m.staff) p += 3;
      if (m.status) p += 2;
      if (m.time || m.end || m.duration) p += 2;
      if (m.service) p += 3;
      if (!m.service && !m.staff && !m.time) p -= 10;   // "Fecha, Cliente, Total" es una venta, no una cita
    }
    if (t === 'servicios' && (pareceCita || tieneContacto)) p -= 40;
    if (t === 'clientes' && pareceCita) p -= 40;
    if (t === 'tarjetas' && m.code && m.balance) p += 6;
    if (t === 'paquetes' && m.remaining && m.name) p += 5;
    // Una columna de puntos o sellos no la trae una lista de clientes ("Total visits" sí).
    if (t === 'lealtad' && m.count && /point|punto|stamp|sello|punch|reward|loyal/.test(clave(m.count))) p += 6;
    if (t === 'lealtad' && mapas.paquetes.remaining && mapas.paquetes.name) p -= 20;
    puntos[t] = p;
  }
  const orden = [...ORDEN_TIPOS].sort((a, b) => puntos[b] - puntos[a]);
  const [a, b] = orden;
  return {
    tipo: puntos[a] >= 100 ? a : null,
    mapa: mapas[a],
    mapas,
    dudoso: puntos[a] < 100 || (puntos[b] >= 100 && puntos[a] - puntos[b] < 4),
  };
}

// ---------- Valores ----------
function telefono(v, normPhone) {
  const s = txt(v, 80);
  if (!s) return null;
  for (const parte of s.split(/[,;/|]| or | o /i)) {
    const p = normPhone(parte.replace(/\s*(ext\.?|extension|ext:|x|#)\s*\d+\s*$/i, ''));
    if (p) return p;
  }
  return null;
}
function correo(v, isEmail) {
  const s = txt(v, 254).toLowerCase().replace(/^mailto:/, '');
  const m = s.match(/[^\s,;<>"']+@[^\s,;<>"']+\.[a-z]{2,}/);
  return m && isEmail(m[0]) ? m[0] : null;
}

// Dinero a centavos: "$1,234.50", "25", "(25.00)" o "-$25" (reembolso), "25,50", "Desde $25".
function centavos(v) {
  const s = txt(v, 60);
  if (!s) return null;
  if (/^(free|gratis|gratuito|n\/a)$/i.test(s)) return /n\/a/i.test(s) ? null : 0;
  const m = s.match(/\d[\d,]*(?:\.\d{1,4})?/);
  if (!m) return null;
  const neg = /^\s*\(.*\)\s*$/.test(s) || s.slice(0, m.index).includes('-');   // "-$25" sí; "$25 - $35" no
  let n = m[0];
  if (/^\d+,\d{1,2}$/.test(n)) n = n.replace(',', '.');
  else n = n.replace(/,/g, '');
  const c = Math.round(parseFloat(n) * 100);
  if (!Number.isFinite(c) || c > 10_000_000) return null;   // más de $100,000 en una fila: no es un precio
  return neg ? -c : c;
}

function entero(v) {
  const s = txt(v, 30).replace(/,/g, '');
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Math.round(parseFloat(m[0]));
  return Number.isFinite(n) ? n : null;
}

// Duración en minutos: "30", "30 min", "1h", "1h 30min", "1h30", "1:30", "1.5 horas", "PT1H30M".
function minutos(v) {
  const s = sinAcentos(txt(v, 40)).toLowerCase();
  if (!s) return null;
  let m;
  if ((m = s.match(/^pt(?:(\d+)h)?(?:(\d+)m)?/)) && (m[1] || m[2])) return (+m[1] || 0) * 60 + (+m[2] || 0);
  if ((m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/))) return +m[1] * 60 + +m[2];
  if ((m = s.match(/(\d+)\s*h(?:r|rs|ora|oras|our|ours)?\s*(\d{1,2})\b(?!\s*h)/))) return +m[1] * 60 + +m[2];
  let total = 0, hay = false;
  const h = s.match(/(\d+(?:[.,]\d+)?)\s*(h|hr|hrs|hora|horas|hour|hours)\b/);
  if (h) { total += parseFloat(h[1].replace(',', '.')) * 60; hay = true; }
  const mi = s.match(/(\d+)\s*(m|min|mins|minuto|minutos|minute|minutes)\b/);
  if (mi) { total += +mi[1]; hay = true; }
  if (hay) return Math.round(total) || null;
  if ((m = s.match(/^(\d+(?:[.,]\d+)?)$/))) {
    const n = parseFloat(m[1].replace(',', '.'));
    return n <= 8 ? Math.round(n * 60) : Math.round(n);   // "1" o "1.5" son horas; nadie vende servicios de 1 minuto
  }
  return null;
}

const MESES = {
  jan: 1, january: 1, ene: 1, enero: 1, feb: 2, february: 2, febrero: 2, mar: 3, march: 3, marzo: 3,
  apr: 4, april: 4, abr: 4, abril: 4, may: 5, mayo: 5, jun: 6, june: 6, junio: 6, jul: 7, july: 7, julio: 7,
  aug: 8, august: 8, ago: 8, agosto: 8, sep: 9, sept: 9, september: 9, septiembre: 9, setiembre: 9,
  oct: 10, october: 10, octubre: 10, nov: 11, november: 11, noviembre: 11, dec: 12, december: 12, dic: 12, diciembre: 12,
};
// "2026-11-20T14:00" → "2026-11-20 14:00" (la T pegada no deja ver la hora); "p. m." → "pm".
const limpiarFecha = (v) => sinAcentos(txt(v, 80)).toLowerCase()
  .replace(/(\d)t(\d)/g, '$1 $2')
  .replace(/\b([ap])\.?\s?m\.?(?=\s|$)/g, '$1m').replace(/\s+/g, ' ').trim();

function leerHora(v) {
  const s = limpiarFecha(v);
  let hh, mm, ap, m;
  if ((m = s.match(/\b(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(am|pm)?\b/))) { hh = +m[1]; mm = +m[2]; ap = m[3]; }
  else if ((m = s.match(/\b(\d{1,2})\s*(am|pm)\b/))) { hh = +m[1]; mm = 0; ap = m[2]; }
  else return null;
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

// ¿La columna viene día/mes o mes/día? Si algún valor empieza con más de 12, es día/mes.
// Si ninguno lo aclara se lee mes/día (como en EE. UU. y Puerto Rico) y se marca dudosa
// cuando alguna fecha se puede leer de las dos maneras (5/3 = 3 de mayo o 5 de marzo).
function ordenFechas(valores, conDuda) {
  let dudosa = false;
  for (const v of valores) {
    const m = limpiarFecha(v).match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/);
    if (!m) continue;
    if (+m[1] > 12) return conDuda ? { orden: 'dmy', dudosa: false } : 'dmy';
    if (+m[2] > 12) return conDuda ? { orden: 'mdy', dudosa: false } : 'mdy';
    if (m[1] !== m[2]) dudosa = true;
  }
  return conDuda ? { orden: 'mdy', dudosa } : 'mdy';
}

// Fecha (y hora si la trae). Sin zona, la hora es de Puerto Rico.
function leerFecha(v, orden = 'mdy') {
  const s = limpiarFecha(v);
  if (!s) return null;
  // Con zona (Z, UTC, +00:00, +0000): es un instante exacto. Sin zona, sigue abajo como hora de PR.
  const iso = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?) ?(z|utc|gmt|[+-]\d{2}:?\d{2})$/);
  if (iso) {
    const zona = /^(z|utc|gmt)$/.test(iso[3]) ? 'Z' : iso[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    const d = new Date(`${iso[1]}T${iso[2]}${zona}`);
    return isNaN(d) ? null : { abs: d, conHora: true };
  }
  let y, mo, d, x;
  if ((x = s.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) { y = +x[1]; mo = +x[2]; d = +x[3]; }
  else if ((x = s.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/))) {
    const a = +x[1], b = +x[2];
    y = +x[3];
    if (y < 100) y += y > 50 ? 1900 : 2000;
    if (orden === 'dmy' || a > 12) { d = a; mo = b; } else { mo = a; d = b; }
  } else if ((x = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?(?: de)? ([a-z]{3,10})\.?,?(?: de| del)? (\d{4})\b/)) && MESES[x[2]]) {
    d = +x[1]; mo = MESES[x[2]]; y = +x[3];
  } else if ((x = s.match(/\b([a-z]{3,10})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})\b/)) && MESES[x[1]]) {
    mo = MESES[x[1]]; d = +x[2]; y = +x[3];
  } else if ((x = s.match(/^(\d{1,2})[-/.](\d{1,2})$/))) {
    const a = +x[1], b = +x[2];
    if (orden === 'dmy' || a > 12) { d = a; mo = b; } else { mo = a; d = b; }
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? { sinAno: true, mo, d } : null;
  } else if ((x = s.match(/^(\d{1,2})(?: de)? ([a-z]{3,10})$/)) && MESES[x[2]]) {
    return { sinAno: true, mo: MESES[x[2]], d: +x[1] };
  } else if ((x = s.match(/^([a-z]{3,10})\.? (\d{1,2})$/)) && MESES[x[1]]) {
    return { sinAno: true, mo: MESES[x[1]], d: +x[2] };
  } else return null;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2100)) return null;
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return null;   // 31 de febrero
  const h = leerHora(s.replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/, ' '));
  return { y, mo, d, hh: h ? h.hh : null, mm: h ? h.mm : null, conHora: !!h };
}

// A un instante. sinHora: la hora que se pone si la fecha no la trae (o null = no sirve).
function instante(f, sinHora = null) {
  if (!f || f.sinAno) return null;
  if (f.abs) return f.abs;
  const hh = f.conHora ? f.hh : sinHora && sinHora.hh;
  const mm = f.conHora ? f.mm : sinHora && sinHora.mm;
  if (hh == null) return null;
  return new Date(Date.UTC(f.y, f.mo - 1, f.d, hh + PR_UTC, mm || 0));
}
const MESES_TXT = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// El estado se compara entero: "Incomplete", "Not completed" o "Unpaid" no son "completada".
const COMPLETADA = new Set(['completed', 'complete', 'completada', 'completado', 'checkedout', 'checkout', 'finished',
  'done', 'atendida', 'atendido', 'terminada', 'terminado', 'realizada', 'realizado', 'closed', 'cerrada', 'cerrado', 'served']);
const NO_LLEGO = new Set(['noshow', 'nollego', 'nosepresento', 'missed', 'ausente', 'falto', 'didnotshow', 'didntshow']);
function estadoCita(v) {
  const s = clave(v);
  if (!s) return null;
  if (/cancel|anulad|rechaz|declin|deleted|borrad/.test(s) && !/^(no|not|un)cancel/.test(s)) return 'cancelada';
  if (NO_LLEGO.has(s)) return 'no_show';
  if (COMPLETADA.has(s)) return 'completada';
  return 'reservada';
}

// ---------- Normalizar un archivo ----------
// Devuelve lo que pasaría (items) y lo que se queda fuera con su porqué, fila por fila.
// filas son solo las de datos; numFila es su número en el archivo (para que el negocio la encuentre).
function normalizar(tipo, encabezados, filas, mapa, ctx) {
  const { normPhone, isEmail, ahora = new Date(), primeraFila = 2, orden: ordenPedido } = ctx;
  const col = {};
  for (const [campo, h] of Object.entries(mapa || {})) {
    const i = h ? encabezados.indexOf(h) : -1;
    if (i >= 0) col[campo] = i;
  }
  const val = (f, campo) => (col[campo] == null ? '' : f[col[campo]]);
  const items = [], fuera = [];
  let repetidos = 0, canceladas = 0;
  const vacia = (f) => !f.some((c) => txt(c, 5));
  const ordenes = {};
  let fechasDudosas = false;
  for (const campo of ['datetime', 'date', 'last_visit', 'birthday', 'expires']) {
    if (col[campo] == null) continue;
    const o = ordenPedido === 'dmy' || ordenPedido === 'mdy' ? { orden: ordenPedido, dudosa: false } : ordenFechas(filas.slice(0, 2000).map((f) => f[col[campo]]), true);
    ordenes[campo] = o.orden;
    if (o.dudosa && campo !== 'birthday') fechasDudosas = true;
  }
  const nombreDe = (f) => txt(val(f, 'full_name') || val(f, 'client_name')
    || [val(f, 'first_name') || val(f, 'client_first'), val(f, 'last_name') || val(f, 'client_last')].map((x) => txt(x, 60)).filter(Boolean).join(' '), 120);
  const clienteDe = (f) => ({ phone: telefono(val(f, 'phone'), normPhone), email: correo(val(f, 'email'), isEmail), name: nombreDe(f) });
  const fueraDe = (n, motivo, f) => fuera.push({ fila: n, motivo, texto: txt(f.filter((c) => txt(c, 40)).slice(0, 3).join(' · '), 90) });

  if (tipo === 'clientes') {
    const porTel = new Map();
    filas.forEach((f, k) => {
      const n = primeraFila + k;
      if (vacia(f)) return;
      const phone = telefono(val(f, 'phone'), normPhone);
      if (!phone) return fueraDe(n, 'sin teléfono de Puerto Rico o EE. UU.', f);
      const email = correo(val(f, 'email'), isEmail);
      let nota = txt(val(f, 'notes'), 600);
      const cumple = col.birthday != null ? leerFecha(val(f, 'birthday'), ordenes.birthday) : null;
      if (cumple && !cumple.abs) nota = [nota, `Cumpleaños: ${cumple.d} de ${MESES_TXT[cumple.mo - 1]}`].filter(Boolean).join('\n');
      const ultima = col.last_visit != null ? instante(leerFecha(val(f, 'last_visit'), ordenes.last_visit), { hh: 12, mm: 0 }) : null;
      const visitas = col.visits != null ? entero(val(f, 'visits')) : null;
      const gasto = col.spent != null ? centavos(val(f, 'spent')) : null;
      const it = {
        fila: n, phone, email, full_name: nombreDe(f) || 'Sin nombre', notes: nota || null,
        visits: visitas != null && visitas >= 0 && visitas < 100000 ? visitas : null,
        spent_cents: gasto != null && gasto >= 0 ? gasto : null,
        last_visit: ultima && ultima <= ahora ? ultima.toISOString() : null,
      };
      const ya = porTel.get(phone);
      if (ya) {   // el mismo teléfono dos veces: se juntan (lo que falta en una lo trae la otra)
        repetidos++;
        for (const k2 of ['email', 'notes', 'visits', 'spent_cents', 'last_visit']) if (ya[k2] == null && it[k2] != null) ya[k2] = it[k2];
        if (ya.full_name === 'Sin nombre') ya.full_name = it.full_name;
        return;
      }
      porTel.set(phone, it);
      items.push(it);
    });
  }

  if (tipo === 'servicios') {
    const vistos = new Set();
    filas.forEach((f, k) => {
      const n = primeraFila + k;
      if (vacia(f)) return;
      const name = txt(val(f, 'name'), 120);
      if (!name) return fueraDe(n, 'sin nombre', f);
      const key = clave(name);
      if (vistos.has(key)) { repetidos++; return; }
      vistos.add(key);
      let dur = col.duration != null ? minutos(val(f, 'duration')) : null;
      const sinDuracion = !dur;
      if (!dur) dur = 30;
      dur = Math.min(480, Math.max(5, Math.round(dur / 5) * 5));
      let precio = col.price != null ? centavos(val(f, 'price')) : null;
      const sinPrecio = precio == null || precio < 0;
      if (sinPrecio) precio = 0;
      items.push({ fila: n, name, duration_min: dur, price_cents: precio, description: txt(val(f, 'description'), 500) || null,
        sin_duracion: sinDuracion, sin_precio: sinPrecio });
    });
  }

  if (tipo === 'citas') {
    const lejos = new Date(ahora.getTime() + 548 * 86400_000);   // ~18 meses
    filas.forEach((f, k) => {
      const n = primeraFila + k;
      if (vacia(f)) return;
      let fh = col.datetime != null ? leerFecha(val(f, 'datetime'), ordenes.datetime) : null;
      const fd = col.date != null ? leerFecha(val(f, 'date'), ordenes.date) : null;
      if (!fh || fh.sinAno) fh = fd;   // la columna de "fecha y hora" a veces trae solo la hora
      // Sin hora, o a las 12:00 a. m. exactas (Excel guarda así una fecha sola): manda la columna de la hora.
      if (fh && !fh.abs && (!fh.conHora || (fh.hh === 0 && fh.mm === 0 && col.time != null))) {
        const h = leerHora(val(f, 'time')) || (col.datetime != null && col.date != null ? leerHora(val(f, 'datetime')) : null);
        if (h) fh = { ...fh, hh: h.hh, mm: h.mm, conHora: true };
      }
      if (!fh || fh.sinAno) return fueraDe(n, 'sin fecha', f);
      const est = estadoCita(val(f, 'status'));
      if (est === 'cancelada') { canceladas++; return; }
      const cliente = clienteDe(f);
      if (!cliente.phone && !cliente.email && !cliente.name) return fueraDe(n, 'sin cliente', f);
      const sinHoraTodavia = !fh.abs && !fh.conHora;
      const start = instante(fh, { hh: 12, mm: 0 });
      // Lo que todavía no pasa es una cita, diga lo que diga el estado (nadie completa una cita del futuro).
      const futura = start > ahora;
      if (futura && sinHoraTodavia) return fueraDe(n, 'cita futura sin hora', f);
      if (start > lejos) return fueraDe(n, 'más de 18 meses en el futuro', f);
      let dur = col.duration != null ? minutos(val(f, 'duration')) : null;
      if (!dur && col.end != null) {
        let fe = leerFecha(val(f, 'end'), ordenes.datetime);
        if (!fe || fe.sinAno || !fe.conHora) { const h = leerHora(val(f, 'end')); fe = h ? { ...fh, hh: h.hh, mm: h.mm, conHora: true, abs: null } : null; }
        const end = fe ? instante(fe) : null;
        if (end && end > start) dur = Math.round((end - start) / 60_000);
      }
      if (dur) dur = Math.min(480, Math.max(5, dur));
      const precio = col.price != null ? centavos(val(f, 'price')) : null;
      items.push({
        fila: n, start: start.toISOString(), futura, estado: futura ? 'reservada' : (est === 'no_show' ? 'no_show' : 'completada'),
        client: cliente, service: txt(val(f, 'service'), 120) || null, staff: txt(val(f, 'staff'), 80) || null,
        duration_min: dur || null, price_cents: precio != null && precio >= 0 ? precio : null,
        notes: txt(val(f, 'notes'), 500) || null,
      });
    });
  }

  if (tipo === 'ventas') {
    filas.forEach((f, k) => {
      const n = primeraFila + k;
      if (vacia(f)) return;
      const fecha = leerFecha(val(f, 'date'), ordenes.date);
      const when = instante(fecha, { hh: 12, mm: 0 });
      if (!when) return fueraDe(n, 'sin fecha (puede ser la fila de totales)', f);
      if (when > ahora) return fueraDe(n, 'fecha en el futuro', f);
      const monto = centavos(val(f, 'amount'));
      if (!monto) return fueraDe(n, 'sin monto', f);
      const tip = col.tip != null ? centavos(val(f, 'tip')) : null;
      const tax = col.tax != null ? centavos(val(f, 'tax')) : null;
      items.push({ fila: n, sold_at: when.toISOString(), amount_cents: monto, tip_cents: tip > 0 ? tip : 0, tax_cents: tax > 0 ? tax : 0,
        description: txt(val(f, 'description'), 200) || null, client_name: txt(val(f, 'client_name'), 120) || null,
        method: txt(val(f, 'method'), 40) || null });
    });
  }

  if (tipo === 'tarjetas') {
    const vistos = new Set();
    filas.forEach((f, k) => {
      const n = primeraFila + k;
      if (vacia(f)) return;
      const code = txt(val(f, 'code'), 40).toUpperCase().replace(/\s+/g, '');
      if (!code || !/^[A-Z0-9-]{3,40}$/.test(code)) return fueraDe(n, 'sin código', f);
      if (vistos.has(code)) { repetidos++; return; }
      vistos.add(code);
      const saldo = centavos(val(f, 'balance'));
      if (!(saldo > 0)) return fueraDe(n, 'sin saldo (ya se usó completa)', f);
      const inicial = col.initial != null ? centavos(val(f, 'initial')) : null;
      const vence = col.expires != null ? instante(leerFecha(val(f, 'expires'), ordenes.expires), { hh: 23, mm: 59 }) : null;
      if (vence && vence < ahora) return fueraDe(n, 'vencida', f);
      items.push({
        fila: n, code, balance_cents: saldo, initial_cents: inicial && inicial >= saldo ? inicial : saldo,
        purchaser_name: txt(val(f, 'purchaser_name'), 120) || null, purchaser_email: correo(val(f, 'purchaser_email'), isEmail),
        recipient_name: txt(val(f, 'recipient_name'), 120) || null, recipient_email: correo(val(f, 'recipient_email'), isEmail),
        expires: vence ? vence.toISOString() : null,
      });
    });
  }

  if (tipo === 'paquetes') {
    filas.forEach((f, k) => {
      const n = primeraFila + k;
      if (vacia(f)) return;
      const cliente = clienteDe(f);
      if (!cliente.phone && !cliente.email && !cliente.name) return fueraDe(n, 'sin cliente', f);
      const quedan = entero(val(f, 'remaining'));
      if (!(quedan > 0)) return fueraDe(n, 'no le quedan visitas', f);
      if (quedan > 999) return fueraDe(n, 'más de 999 visitas', f);
      const total = col.total != null ? entero(val(f, 'total')) : null;
      const vence = col.expires != null ? instante(leerFecha(val(f, 'expires'), ordenes.expires), { hh: 23, mm: 59 }) : null;
      if (vence && vence < ahora) return fueraDe(n, 'vencido', f);
      const precio = col.price != null ? centavos(val(f, 'price')) : null;
      items.push({ fila: n, client: cliente, name: txt(val(f, 'name'), 120) || 'Paquete', remaining: quedan,
        total: total && total >= quedan && total <= 999 ? total : quedan, expires: vence ? vence.toISOString() : null,
        price_cents: precio > 0 ? precio : null });
    });
  }

  if (tipo === 'lealtad') {
    filas.forEach((f, k) => {
      const n = primeraFila + k;
      if (vacia(f)) return;
      const cliente = clienteDe(f);
      if (!cliente.phone && !cliente.email && !cliente.name) return fueraDe(n, 'sin cliente', f);
      const cuenta = entero(val(f, 'count'));
      if (!(cuenta > 0)) return fueraDe(n, 'sin puntos', f);
      items.push({ fila: n, client: cliente, count: Math.min(cuenta, 100000) });
    });
  }

  return { items, fuera, repetidos, canceladas, fechasDudosas };
}

// ---------- Para la IA ----------
// Claude no ve datos de clientes: solo los encabezados y la FORMA de unas filas (letras
// como x/X y números como 9). "Ana Ríos" → "Xxx Xxxxx", "(787) 555-1234" → "(999) 999-9999".
function tapar(v) {
  return txt(v, 40).replace(/\p{L}/gu, (c) => (/\p{Lu}|\p{Lt}/u.test(c) ? 'X' : 'x')).replace(/\p{N}/gu, '9');
}
// ¿Este encabezado se le puede enseñar a Claude tal cual? Solo si contiene alguna palabra
// de las que traen los encabezados de siempre y no parece un dato (un nombre o un teléfono
// de una lista sin encabezados). Los demás van como "Columna N".
const PALABRAS = [...new Set(Object.values(TIPOS).flatMap((t) => Object.values(t.campos).flatMap((f) => f.s)).filter((s) => s.length >= 4))];
function encabezadoConocido(h) {
  const k = clave(h);
  return !!k && !pareceDato(h) && k.length <= 40 && PALABRAS.some((p) => k.includes(p));
}

module.exports = {
  TIPOS, ORDEN_TIPOS, sinAcentos, clave, txt, encontrarEncabezado, encabezadosUnicos, mapear, completo, faltan, detectar,
  telefono, correo, centavos, entero, minutos, leerFecha, leerHora, ordenFechas, instante, estadoCita, normalizar, tapar,
  encabezadoConocido, pareceDato,
};
