(() => {
  // Due set di frame estratti dallo stesso video da strumenti/estrai-frame.py:
  // - desktop: il video intero, 1600x900;
  // - mobile: per i telefoni in verticale, già inquadrati (600x900) sul soggetto di ogni
  //   scena. L'inquadratura (focus, zoom) si decide lì, non qui: questo file li disegna
  //   semplicemente a tutto schermo. Le keyframe di quello script devono restare le
  //   stesse di TIMELINE qui sotto.
  const FRAME_SETS = {
    desktop: { dir: 'assets/frames/desktop', count: 553 },
    mobile: { dir: 'assets/frames/mobile', count: 553 },
  };
  // I fotogrammi restano nella cache del browser per una settimana (vercel.json): ogni volta
  // che vengono rigenerati questo numero va aumentato, altrimenti chi ha già visitato il sito
  // vede un misto di vecchi e nuovi. Va cambiato anche nei <link rel="preload"> di index.html
  const FRAME_VERSION = 2;

  // Timeline dello scroll. Le keyframe sono i frame su cui compare una scena: lì lo scroll
  // si "ferma" per `hold` vh mentre il video resta fermo, così i contenuti si leggono con
  // calma. Tra una keyframe e l'altra il video avanza.
  const TIMELINE = {
    referenceFrames: FRAME_SETS.desktop.count,
    vhPerFrame: 0.7,
    maxFade: 35,
    keyframes: [
      { id: 'intro', frame: 0, hold: 50 },
      { id: 'hero', frame: 82, hold: 90 },
      { id: 'about', frame: 278, hold: 90 },
      { id: 'services', frame: 408, hold: 90 },
      { id: 'contact', frame: 552, hold: 60 },
    ],
  };

  const CONFIG = {
    // 0..1: quanto la posizione mostrata "insegue" quella reale ogni 1/60 di secondo.
    // 1 = aggancio immediato allo scroll, valori bassi = movimento più morbido.
    smoothing: 0.18,
    // Quante immagini scaricare in parallelo: con HTTP/2 viaggiano sulla stessa connessione,
    // e sulle reti mobili conta soprattutto l'attesa di ogni singola richiesta
    concurrency: 16,
    // Schermi in verticale e non più larghi di così usano il set mobile
    mobileQuery: '(orientation: portrait) and (max-width: 900px)',
    // Risoluzione del canvas: segue la densità dello schermo (fino a 3x) ma senza superare
    // questi pixel totali, oltre i quali ogni disegno costa di più senza guadagnare nitidezza
    maxCanvasPixels: 3.5e6,
  };

  // Schermata di caricamento: resta finché non è arrivata la quota `readyRatio` dei
  // fotogrammi. Arrivano a raffinamento progressivo (vedi loadOrder), quindi a metà c'è già
  // un fotogramma ogni due lungo tutto il video: lo scroll è fluido e il resto arriva mentre
  // si legge il benvenuto. Con una connessione lenta si parte comunque dopo `maxWait` ms.
  // `minShow` evita un lampo quando i fotogrammi sono già nella cache del browser.
  const LOADER = { readyRatio: 0.5, minShow: 900, maxWait: 10000 };

  const section = document.getElementById('scroll-video');
  const sticky = section.querySelector('.scroll-video__sticky');
  const canvas = document.getElementById('scroll-video-canvas');
  const loader = document.getElementById('site-loader');
  const loaderValue = loader.querySelector('[data-loader-value]');
  const ctx = canvas.getContext('2d', { alpha: false });
  const mobileMedia = window.matchMedia(CONFIG.mobileQuery);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const startTime = performance.now();

  let set = null;
  let frames = [];
  let loadedCount = 0;
  let loadingDone = false;
  // Incrementato ad ogni cambio di set: i caricamenti del set precedente vengono ignorati
  let generation = 0;

  // Posizioni lungo la timeline, in vh di scroll (0..timeline.length)
  let targetPos = 0;
  let currentPos = 0;
  let drawnFrame = -1;
  let rafId = null;
  let lastTick = 0;
  const listeners = new Set();
  // Misure della pagina, rilette solo al ridimensionamento: leggerle ad ogni scroll
  // costringe il browser a ricalcolare il layout
  const geometry = { top: 0, pxPerUnit: 1 };

  const framePath = (s, i) => `${s.dir}/frame_${String(i + 1).padStart(4, '0')}.webp?v=${FRAME_VERSION}`;

  // --- Timeline -------------------------------------------------------------

  function buildTimeline() {
    let pos = 0;
    const keys = TIMELINE.keyframes.map((k, i, all) => {
      if (i > 0) pos += (k.frame - all[i - 1].frame) * TIMELINE.vhPerFrame;
      const key = { ...k, t: k.frame / (TIMELINE.referenceFrames - 1), start: pos, end: pos + k.hold };
      pos += k.hold;
      return key;
    });
    // Le scene compaiono nella seconda metà del tratto di video che le precede
    // e spariscono nella prima metà di quello successivo
    keys.forEach((k, i) => {
      const prev = keys[i - 1];
      const next = keys[i + 1];
      k.fadeIn = prev ? Math.min(TIMELINE.maxFade, (k.start - prev.end) / 2) : 0;
      k.fadeOut = next ? Math.min(TIMELINE.maxFade, (next.start - k.end) / 2) : 0;
    });
    return { keys, length: pos };
  }

  const timeline = buildTimeline();
  section.style.setProperty('--scroll-distance', `${timeline.length}vh`);
  // Tempo del video normalizzato (0..1) a una posizione della timeline: fermo durante
  // le pause, interpolato linearmente tra una keyframe e l'altra
  function posToTime(pos) {
    const { keys } = timeline;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (pos <= k.end) {
        if (pos >= k.start || i === 0) return k.t;
        const prev = keys[i - 1];
        return prev.t + ((k.t - prev.t) * (pos - prev.end)) / (k.start - prev.end);
      }
    }
    return 1;
  }

  // 0..1: quanto è visibile la scena di una keyframe a una data posizione
  function keyOpacity(k, pos) {
    if (pos < k.start) return k.fadeIn ? clamp01(1 - (k.start - pos) / k.fadeIn) : 1;
    if (pos > k.end) return k.fadeOut ? clamp01(1 - (pos - k.end) / k.fadeOut) : 1;
    return 1;
  }

  const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

  // --- Caricamento frame ----------------------------------------------------

  function loadFrame(index, gen) {
    return new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.src = framePath(set, index);
      const done = () => {
        if (gen === generation) {
          frames[index] = img;
          loadedCount++;
          updateLoader();
        }
        resolve();
      };
      img.decode().then(done, () => {
        // decode() può fallire su alcuni browser anche se l'immagine è valida
        if (img.complete && img.naturalWidth) done();
        else img.onload = done;
        img.onerror = () => resolve();
      });
    });
  }

  // Ordine di caricamento: prima il frame corrente, poi le keyframe delle scene,
  // poi "a raffinamento progressivo" (un frame ogni 32, poi ogni 16, 8...) così lo
  // scroll funziona subito (con salti) e si fa fluido man mano.
  function loadOrder(count, start) {
    const keyIndexes = timeline.keys.map((k) => Math.round(k.t * (count - 1)));
    const order = [start, ...keyIndexes];
    const seen = new Set(order);
    for (let step = 32; step >= 1; step = Math.floor(step / 2)) {
      for (let i = 0; i < count; i += step) {
        if (!seen.has(i)) {
          seen.add(i);
          order.push(i);
        }
      }
    }
    if (!seen.has(count - 1)) order.push(count - 1);
    return [...new Set(order)];
  }

  async function loadSet(name) {
    const gen = ++generation;
    set = FRAME_SETS[name];
    frames = new Array(set.count).fill(null);
    loadedCount = 0;
    drawnFrame = -1;

    const queue = loadOrder(set.count, currentFrameIndex());
    await loadFrame(queue.shift(), gen);
    if (gen !== generation) return;
    resize();

    const worker = async () => {
      while (queue.length && gen === generation) {
        await loadFrame(queue.shift(), gen);
        requestRender();
      }
    };
    await Promise.all(Array.from({ length: CONFIG.concurrency }, worker));
  }

  function updateLoader() {
    if (loadingDone) return;
    const progress = loadedCount / (set.count * LOADER.readyRatio);
    const percent = Math.min(Math.floor(progress * 100), 100);
    loaderValue.textContent = String(percent);
    loader.setAttribute('aria-valuenow', String(percent));
    if (progress >= 1) finishLoading();
  }

  function finishLoading() {
    if (loadingDone) return;
    loadingDone = true;
    const wait = Math.max(0, LOADER.minShow - (performance.now() - startTime));
    setTimeout(() => {
      document.documentElement.classList.remove('is-loading');
      loader.classList.add('is-done');
      loader.addEventListener('transitionend', () => (loader.hidden = true), { once: true });
    }, wait);
  }

  // In una scheda aperta in secondo piano il browser rimanda il caricamento delle immagini:
  // l'attesa massima parte solo quando la pagina è visibile
  const startMaxWait = () => setTimeout(finishLoading, LOADER.maxWait);
  if (document.hidden) document.addEventListener('visibilitychange', startMaxWait, { once: true });
  else startMaxWait();

  // Se il frame richiesto non è ancora arrivato, usa il più vicino già caricato
  function nearestLoaded(index) {
    if (frames[index]) return frames[index];
    for (let d = 1; d < frames.length; d++) {
      if (frames[index - d]) return frames[index - d];
      if (frames[index + d]) return frames[index + d];
    }
    return null;
  }

  const currentFrameIndex = () => Math.round(posToTime(currentPos) * (set.count - 1));

  // --- Disegno --------------------------------------------------------------

  function resize() {
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 3, Math.sqrt(CONFIG.maxCanvasPixels / (cssW * cssH)));
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    // Su mobile la comparsa/scomparsa della barra degli indirizzi lancia "resize":
    // ridimensionare il canvas (che lo svuota) solo se cambia davvero
    if (w !== canvas.width || h !== canvas.height) {
      canvas.width = w;
      canvas.height = h;
      // Ridimensionare il canvas azzera anche questa impostazione: ingrandimento con un
      // filtro di qualità, più nitido di quello predefinito
      ctx.imageSmoothingQuality = 'high';
    }
    drawnFrame = -1;
    if (set) draw(currentFrameIndex());
  }

  // Equivalente di "object-fit: cover", centrato
  function draw(index) {
    const img = nearestLoaded(index);
    if (!img) return;

    const cw = canvas.width;
    const ch = canvas.height;
    const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
    drawnFrame = frames[index] ? index : -1;
  }

  // --- Scroll ---------------------------------------------------------------

  // px di scroll per ogni vh della timeline. Usa l'altezza del contenitore sticky e non
  // window.innerHeight, che su mobile cambia con la barra degli indirizzi e farebbe "saltare" il video
  function measure() {
    geometry.top = section.getBoundingClientRect().top + window.scrollY;
    geometry.pxPerUnit = Math.max(section.offsetHeight - sticky.offsetHeight, 1) / timeline.length;
  }

  const scrollPos = () =>
    Math.min(Math.max((window.scrollY - geometry.top) / geometry.pxPerUnit, 0), timeline.length);

  function tick(now) {
    rafId = null;

    // Inseguimento in base al tempo trascorso: stessa velocità su schermi a 60 e a 120 Hz
    const dt = lastTick ? Math.min(now - lastTick, 100) : 1000 / 60;
    lastTick = now;
    const follow = 1 - (1 - CONFIG.smoothing) ** (dt / (1000 / 60));
    currentPos += (targetPos - currentPos) * follow;
    if (Math.abs(targetPos - currentPos) < 0.01) currentPos = targetPos;

    const index = currentFrameIndex();
    if (index !== drawnFrame) draw(index);
    listeners.forEach((fn) => fn(currentPos));

    if (currentPos !== targetPos) rafId = requestAnimationFrame(tick);
    else lastTick = 0;
  }

  function requestRender() {
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  function onScroll() {
    targetPos = scrollPos();
    requestRender();
  }

  // Scorrimento animato della pagina (usato da menu e pulsanti). Lo scroll "smooth" nativo
  // percorre lunghe distanze in modo brusco; qui la durata cresce con la distanza e
  // l'andamento accelera e rallenta dolcemente, così il video scorre in modo fluido.
  const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
  let scrollAnimId = null;

  // Sui telefoni, durante l'animazione, lo scroll a mano è bloccato (html.is-gliding): così
  // l'inerzia dello swipe appena fatto non la contrasta. Su desktop no, perché nascondere la
  // barra di scorrimento sposterebbe la pagina.
  const glideLock = (on) => document.documentElement.classList.toggle('is-gliding', on);

  function cancelScrollAnimation() {
    if (scrollAnimId !== null) cancelAnimationFrame(scrollAnimId);
    scrollAnimId = null;
    glideLock(false);
  }

  function animateScrollTo(top, instant = reducedMotion) {
    cancelScrollAnimation();
    const from = window.scrollY;
    const distance = top - from;
    if (instant || Math.abs(distance) < 2) {
      window.scrollTo(0, top);
      return;
    }
    // Circa 0,45 s per schermata, tra 1 e 3 secondi
    const duration = Math.min(Math.max((Math.abs(distance) / window.innerHeight) * 450, 1000), 3000);
    const start = performance.now();
    glideLock(mobileMedia.matches);
    const step = (now) => {
      const p = Math.min((now - start) / duration, 1);
      window.scrollTo(0, from + distance * easeInOutCubic(p));
      if (p < 1) scrollAnimId = requestAnimationFrame(step);
      else cancelScrollAnimation();
    };
    scrollAnimId = requestAnimationFrame(step);
  }

  // Se l'utente scorre da solo durante l'animazione, gli lascia subito il controllo
  ['wheel', 'touchstart', 'keydown'].forEach((type) =>
    window.addEventListener(type, cancelScrollAnimation, { passive: true })
  );

  // Punto di scroll di una scena: a metà della sua pausa (il benvenuto in cima alla pagina)
  const keyTop = (k) => geometry.top + (k === timeline.keys[0] ? 0 : (k.start + k.hold / 2) * geometry.pxPerUnit);

  function scrollToKey(id, instant) {
    const k = timeline.keys.find((key) => key.id === id);
    if (k) animateScrollTo(keyTop(k), instant);
  }

  // --- Telefoni: una sezione per gesto ----------------------------------------
  // Mentre il dito è appoggiato il video lo segue come sempre; al rilascio la pagina
  // scivola fino alla sezione successiva o precedente, o torna a quella di partenza se il
  // gesto è stato minimo. Così non si resta mai a metà strada tra due sezioni.
  const SWIPE_THRESHOLD = 30; // px
  let touchStartY = null;
  let touchStartKey = 0;

  const nearestKey = (y) =>
    timeline.keys.reduce((best, k, i) => (Math.abs(keyTop(k) - y) < Math.abs(keyTop(timeline.keys[best]) - y) ? i : best), 0);

  window.addEventListener('touchstart', (e) => {
    touchStartY = mobileMedia.matches && e.touches.length === 1 ? window.scrollY : null;
    if (touchStartY !== null) touchStartKey = nearestKey(touchStartY);
  }, { passive: true });

  function onTouchEnd(e) {
    if (touchStartY === null || e.touches.length) return;
    const delta = window.scrollY - touchStartY;
    touchStartY = null;
    // Menu o modulo aperti, o schermata di caricamento: la pagina sotto è ferma
    const root = document.documentElement;
    if (root.classList.contains('is-locked') || root.classList.contains('is-loading')) return;

    let target = touchStartKey;
    if (delta > SWIPE_THRESHOLD) target += 1;
    else if (delta < -SWIPE_THRESHOLD) target -= 1;
    target = Math.min(Math.max(target, 0), timeline.keys.length - 1);
    const top = keyTop(timeline.keys[target]);
    if (Math.abs(window.scrollY - top) > 1) animateScrollTo(top);
  }

  window.addEventListener('touchend', onTouchEnd, { passive: true });
  window.addEventListener('touchcancel', onTouchEnd, { passive: true });

  // Chi preferisce meno animazioni ottiene l'aggancio diretto, senza inerzia
  if (reducedMotion) CONFIG.smoothing = 1;

  const setName = () => (mobileMedia.matches ? 'mobile' : 'desktop');

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => {
    measure();
    resize();
    onScroll();
  });
  // Rotazione del telefono / ridimensionamento finestra oltre la soglia: cambia set di frame
  mobileMedia.addEventListener('change', () => loadSet(setName()));

  // Riparte dal punto giusto se la pagina viene ricaricata a metà scroll
  measure();
  targetPos = currentPos = scrollPos();
  loadSet(setName());

  // API usata da js/site.js per sincronizzare i contenuti con il video
  window.ScrollVideo = {
    keys: timeline.keys,
    length: timeline.length,
    keyOpacity,
    scrollToKey,
    scrollTo: animateScrollTo,
    subscribe(fn) {
      listeners.add(fn);
      fn(currentPos);
    },
  };
})();
