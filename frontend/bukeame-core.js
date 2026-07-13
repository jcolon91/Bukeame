/* ============================================================================
 * Bukéame — núcleo de robustez del frontend (app + web)
 *   · Boundary global de errores (window error + promesas sin catch)
 *   · Reporte a Sentry (si hay DSN / loader configurado; si no, no-op)
 *   · bkState(): estados async estándar → skeleton (cargando) · vacío · error+reintentar
 *   · bkToast(): avisos no bloqueantes
 *   · Banner "sin conexión"
 *
 * Cargar TEMPRANO en cada página, dentro del <head>, ANTES del resto de scripts:
 *   <script src="bukeame-core.js"></script>
 * Es un IIFE: define window.bkState / bkToast / bkCaptureError de inmediato.
 * ==========================================================================*/
(function () {
  'use strict';
  var W = window, D = document;

  /* ---------- Sentry (opcional) ---------------------------------------------
   * Se activa de DOS formas:
   *  (a) Pegas el "Loader Script" oficial de Sentry en tus páginas → window.Sentry existe.
   *  (b) Defines el DSN y este core carga el bundle:
   *        <meta name="bukeame-sentry-dsn" content="https://xxx@oyyy.ingest.sentry.io/zzz">
   *      o  window.BUKEAME_SENTRY_DSN = '...';  (antes de este script)
   * Sin ninguna de las dos, bkCaptureError es un no-op (la UI de error igual funciona). */
  var DSN = W.BUKEAME_SENTRY_DSN
    || ((D.querySelector('meta[name="bukeame-sentry-dsn"]') || {}).content || '').trim()
    || 'https://0689688cbcd54d6da994e7c9a0488474@o4511727735930880.ingest.us.sentry.io/4511727745236992';

  W.bkCaptureError = function (err, ctx) {
    try {
      if (W.Sentry && W.Sentry.captureException) {
        W.Sentry.captureException(err instanceof Error ? err : new Error(String(err)),
          ctx ? { extra: ctx } : undefined);
      }
    } catch (e) { /* nunca romper por el reporte */ }
  };

  if (DSN && !W.Sentry) {
    var _m = DSN.match(/\/\/([0-9a-f]+)@/i);
    var _key = _m ? _m[1] : '';
    if (_key) {
      // Loader oficial de Sentry (versión-agnóstico; el DSN va embebido por la key).
      // Instala captura de errores de inmediato y carga el SDK bajo demanda.
      W.sentryOnLoad = function () {
        try {
          W.Sentry.init({
            release: W.BUKEAME_RELEASE || 'bukeame-web',
            environment: (location.hostname === 'bukeame.com') ? 'production' : 'staging',
            tracesSampleRate: 0,           // por ahora solo errores (sin performance)
            ignoreErrors: ['ResizeObserver loop', 'Non-Error promise rejection captured']
          });
        } catch (e) { /* si falla el init, seguimos sin Sentry */ }
      };
      var sc = D.createElement('script');
      sc.src = 'https://js.sentry-cdn.com/' + _key + '.min.js';
      sc.crossOrigin = 'anonymous';
      (D.head || D.documentElement).appendChild(sc);
    }
  }

  /* ---------- Boundary global de errores ---------- */
  W.addEventListener('error', function (e) {
    // errores de recursos (img/script que no cargan) tienen e.target y no e.error → no molestar
    if (e && e.error) {
      W.bkCaptureError(e.error);
      bkToast('Ups, algo falló. Intenta de nuevo.', 'err');
    }
  });
  W.addEventListener('unhandledrejection', function (e) {
    W.bkCaptureError(e && e.reason ? e.reason : 'unhandledrejection');
  });

  /* ---------- Toast (aviso no bloqueante) ---------- */
  W.bkToast = function (msg, kind) {
    if (!D.body) { return; }
    var t = D.createElement('div');
    t.className = 'bk-toast' + (kind === 'err' ? ' bk-toast-err' : '');
    t.textContent = msg;
    D.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('on'); });
    setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 320); }, 3800);
  };

  /* ---------- Banner sin conexión ---------- */
  function offlineBanner(show) {
    if (!D.body) return;
    var b = D.getElementById('bk-offline');
    if (!b) { b = D.createElement('div'); b.id = 'bk-offline'; b.textContent = 'Sin conexión. Reintentando…'; D.body.appendChild(b); }
    b.style.display = show ? 'block' : 'none';
  }
  W.addEventListener('offline', function () { offlineBanner(true); });
  W.addEventListener('online', function () { offlineBanner(false); });

  /* ---------- Estado async estándar --------------------------------------- -
   * bkState(el|id, {
   *   load:   () => Promise<data>        // OBLIGATORIO: la llamada async
   *   render: (data, el) => void         // OBLIGATORIO: pinta los datos (no-vacío)
   *   empty:  'texto' | (data)=>string   // opcional: qué mostrar si viene vacío
   *   isEmpty:(data) => boolean          // opcional: cómo decidir "vacío" (default: array vacío / null)
   *   skeleton: 'html' | 'cards:N'       // opcional: skeleton a mostrar mientras carga
   *   errorMsg: 'texto'                  // opcional: mensaje de error
   *   name:   'clientAppts'              // opcional: etiqueta para el reporte a Sentry
   * })
   * Devuelve una función reload() por si quieres re-cargar a mano. */
  W.bkState = function (el, opts) {
    el = (typeof el === 'string') ? D.getElementById(el) : el;
    if (!el || !opts || typeof opts.load !== 'function') return function () {};

    function run() {
      el.innerHTML = skelHtml(opts.skeleton);
      Promise.resolve().then(opts.load).then(function (data) {
        var empty = opts.isEmpty ? !!opts.isEmpty(data)
          : (Array.isArray(data) ? data.length === 0 : (data == null || data === false));
        if (empty) { el.innerHTML = emptyHtml(typeof opts.empty === 'function' ? opts.empty(data) : opts.empty); return; }
        el.innerHTML = '';
        opts.render(data, el);
      }).catch(function (err) {
        W.bkCaptureError(err, { where: opts.name || 'bkState' });
        el.innerHTML = errHtml(opts.errorMsg);
        var btn = el.querySelector('.bk-retry'); if (btn) btn.onclick = run;
      });
    }
    run();
    return run;
  };

  function skelHtml(spec) {
    if (spec && String(spec).indexOf('cards:') === 0) {
      var n = parseInt(String(spec).slice(6), 10) || 3, out = '';
      for (var i = 0; i < n; i++) out += '<div class="bk-card-skel"></div>';
      return out;
    }
    if (spec) return spec; // html custom
    return '<div class="bk-skel-wrap"><div class="bk-skel" style="width:72%"></div>' +
      '<div class="bk-skel" style="width:92%"></div><div class="bk-skel" style="width:58%"></div></div>';
  }
  function emptyHtml(msg) { return '<div class="bk-empty">' + (msg || 'No hay nada por aquí todavía.') + '</div>'; }
  function errHtml(msg) {
    return '<div class="bk-err"><div class="bk-err-msg">' + (msg || 'No se pudo cargar. Revisa tu conexión e intenta de nuevo.') +
      '</div><button type="button" class="bk-retry">Reintentar</button></div>';
  }

  /* ---------- CSS (skeleton, toast, error, vacío, offline) ---------- */
  var css =
    '@keyframes bk-shim{to{background-position:-200% 0}}' +
    '.bk-skel-wrap{display:flex;flex-direction:column;gap:10px;padding:8px 2px}' +
    '.bk-skel{height:16px;border-radius:8px;background:linear-gradient(100deg,rgba(140,150,145,.14) 30%,rgba(140,150,145,.30) 50%,rgba(140,150,145,.14) 70%);background-size:200% 100%;animation:bk-shim 1.25s linear infinite}' +
    '.bk-card-skel{height:88px;border-radius:16px;background:linear-gradient(100deg,rgba(140,150,145,.12) 30%,rgba(140,150,145,.26) 50%,rgba(140,150,145,.12) 70%);background-size:200% 100%;animation:bk-shim 1.25s linear infinite;margin-bottom:12px}' +
    '.bk-empty{text-align:center;color:var(--muted,#8AA197);font-size:14px;padding:34px 22px;line-height:1.6}' +
    '.bk-err{text-align:center;padding:32px 22px}' +
    '.bk-err-msg{color:var(--muted,#8AA197);font-size:14px;margin-bottom:14px;line-height:1.5}' +
    '.bk-retry{background:var(--green,#0E8074);color:var(--green-ink,#fff);font-weight:700;font-size:14px;border:0;border-radius:12px;padding:11px 24px;cursor:pointer}' +
    '.bk-retry:hover{filter:brightness(1.05)}' +
    '.bk-toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,20px);background:#12251B;color:#ECEAE0;font-size:14px;font-weight:600;padding:12px 18px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.35);z-index:100000;opacity:0;transition:opacity .25s,transform .25s;max-width:88vw;text-align:center}' +
    '.bk-toast.on{opacity:1;transform:translate(-50%,0)}' +
    '.bk-toast-err{background:#8a2318;color:#fff}' +
    '#bk-offline{position:fixed;top:0;left:0;right:0;background:#8a2318;color:#fff;font-size:13px;font-weight:600;text-align:center;padding:8px;z-index:100000;display:none}';
  var st = D.createElement('style'); st.textContent = css;
  (D.head || D.documentElement).appendChild(st);

  /* estado inicial de conexión (cuando el body ya exista) */
  function initConn() { if (!navigator.onLine) offlineBanner(true); }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', initConn);
  else initConn();
})();
