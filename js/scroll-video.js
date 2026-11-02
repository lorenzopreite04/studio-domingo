(() => {
  // Due set di frame estratti dallo stesso video, entrambi 1600x900:
  // - desktop: tutti i frame (30 fps)
  // - mobile: un frame su due (15 fps) e compressione più spinta, meno della metà del peso.
  //   Su schermi verticali si vede solo una striscia del video: `pan` la sposta verso
  //   il soggetto di ogni scena (vedi `focus` nelle keyframe)
  const FRAME_SETS = {
    desktop: { dir: 'assets/frames/desktop', count: 553, pan: false },
    mobile: { dir: 'assets/frames/mobile', count: 277, pan: true },
  };

  // Timeline dello scroll. Le keyframe sono i frame (indice nel set desktop) su cui
  // compare una scena: lì lo scroll si "ferma" per `hold` vh mentre il video resta fermo,
  // così i contenuti si leggono con calma. Tra una keyframe e l'altra il video avanza.
  // `focus` (0..1) è il punto orizzontale del frame da tenere al centro quando il video
  // viene ritagliato molto (telefono in verticale): il soggetto della scena.
  const TIMELINE = {
    referenceFrames: FRAME_SETS.desktop.count,
    vhPerFrame: 0.7,
    maxFade: 35,
    keyframes: [
      { id: 'intro', frame: 0, hold: 50, focus: 0.5 },
      { id: 'hero', frame: 82, hold: 90, focus: 0.5 },
      { id: 'about', frame: 278, hold: 90, focus: 0.25 },
      { id: 'services', frame: 408, hold: 90, focus: 0.72 },
      { id: 'contact', frame: 552, hold: 60, focus: 0.26 },
    ],
  };

  const CONFIG = {
    // 0..1: quanto la posizione mostrata "insegue" quella reale ad ogni tick.
    // 1 = aggancio immediato allo scroll, valori bassi = movimento più morbido.
    smoothing: 0.18,
    // Quante immagini scaricare in parallelo
    concurrency: 8,
    // Schermi in verticale e non più larghi di così usano il set mobile
    mobileQuery: '(orientation: portrait) and (max-width: 900px)',
  };

  const section = document.getElementById('scroll-video');
  const sticky = section.querySelector('.scroll-video__sticky');
  const canvas = document.getElementById('scroll-video-canvas');
  const loader = document.getElementById('scroll-video-loader');
  const loaderBar = loader.querySelector('.scroll-video__loader-bar');
  const ctx = canvas.getContext('2d', { alpha: false });
  const mobileMedia = window.matchMedia(CONFIG.mobileQuery);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let set = null;
  let frames = [];
  let loadedCount = 0;
  // Incrementato ad ogni cambio di set: i caricamenti del set precedente vengono ignorati
  let generation = 0;

  // Posizioni lungo la timeline, in vh di scroll (0..timeline.length)
  let targetPos = 0;
  let currentPos = 0;
  let drawnFrame = -1;
  let drawnPos = -1;
  let rafId = null;
  const listeners = new Set();

  const framePath = (s, i) => `${s.dir}/frame_${String(i + 1).padStart(4, '0')}.webp`;

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

  // Valore di una proprietà delle keyframe a una posizione della timeline: fermo durante
  // le pause, interpolato linearmente tra una keyframe e l'altra
  function interpolate(pos, prop) {
    const { keys } = timeline;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (pos <= k.end) {
        if (pos >= k.start || i === 0) return k[prop];
        const prev = keys[i - 1];
        const ratio = (pos - prev.end) / (k.start - prev.end);
        return prev[prop] + (k[prop] - prev[prop]) * ratio;
      }
    }
    return keys[keys.length - 1][prop];
  }

  // Posizione nella timeline -> tempo del video normalizzato (0..1)
  const posToTime = (pos) => interpolate(pos, 't');

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
    loader.classList.remove('is-done');
    updateLoader();
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
    const ratio = set ? loadedCount / set.count : 0;
    loaderBar.style.transform = `scaleX(${ratio})`;
    loader.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    if (ratio === 1) loader.classList.add('is-done');
  }

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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    // Su mobile la comparsa/scomparsa della barra degli indirizzi lancia "resize":
    // ridimensionare il canvas (che lo svuota) solo se cambia davvero
    if (w !== canvas.width || h !== canvas.height) {
      canvas.width = w;
      canvas.height = h;
    }
    drawnFrame = -1;
    draw(currentFrameIndex());
  }

  // Equivalente di "object-fit: cover", con punto focale orizzontale per il set mobile
  function draw(index) {
    const img = nearestLoaded(index);
    if (!img) return;

    const cw = canvas.width;
    const ch = canvas.height;
    const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    const focus = set.pan ? interpolate(currentPos, 'focus') : 0.5;
    const x = Math.min(Math.max(cw / 2 - focus * w, cw - w), 0);

    ctx.drawImage(img, x, (ch - h) / 2, w, h);
    drawnFrame = frames[index] ? index : -1;
    drawnPos = currentPos;
  }

  // --- Scroll ---------------------------------------------------------------

  // px di scroll per ogni vh della timeline. Usa l'altezza del contenitore sticky e non
  // window.innerHeight, che su mobile cambia con la barra degli indirizzi e farebbe "saltare" il video
  const pxPerUnit = () => Math.max(section.offsetHeight - sticky.offsetHeight, 1) / timeline.length;

  function scrollPos() {
    const top = section.getBoundingClientRect().top;
    return Math.min(Math.max(-top / pxPerUnit(), 0), timeline.length);
  }

  function tick() {
    rafId = null;

    currentPos += (targetPos - currentPos) * CONFIG.smoothing;
    if (Math.abs(targetPos - currentPos) < 0.01) currentPos = targetPos;

    const index = currentFrameIndex();
    // Col pan l'inquadratura si sposta anche tra un frame e l'altro
    if (index !== drawnFrame || (set.pan && currentPos !== drawnPos)) draw(index);
    listeners.forEach((fn) => fn(currentPos));

    if (currentPos !== targetPos) rafId = requestAnimationFrame(tick);
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

  function cancelScrollAnimation() {
    if (scrollAnimId !== null) cancelAnimationFrame(scrollAnimId);
    scrollAnimId = null;
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
    const step = (now) => {
      const p = Math.min((now - start) / duration, 1);
      window.scrollTo(0, from + distance * easeInOutCubic(p));
      scrollAnimId = p < 1 ? requestAnimationFrame(step) : null;
    };
    scrollAnimId = requestAnimationFrame(step);
  }

  // Se l'utente scorre da solo durante l'animazione, gli lascia subito il controllo
  ['wheel', 'touchstart', 'keydown'].forEach((type) =>
    window.addEventListener(type, cancelScrollAnimation, { passive: true })
  );

  // Scroll della pagina fino a metà della pausa di una scena
  function scrollToKey(id, instant) {
    const k = timeline.keys.find((key) => key.id === id);
    if (!k) return;
    const sectionTop = section.getBoundingClientRect().top + window.scrollY;
    animateScrollTo(sectionTop + (k.start + k.hold / 2) * pxPerUnit(), instant);
  }

  // Chi preferisce meno animazioni ottiene l'aggancio diretto, senza inerzia
  if (reducedMotion) CONFIG.smoothing = 1;

  const setName = () => (mobileMedia.matches ? 'mobile' : 'desktop');

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => {
    resize();
    onScroll();
  });
  // Rotazione del telefono / ridimensionamento finestra oltre la soglia: cambia set di frame
  mobileMedia.addEventListener('change', () => loadSet(setName()));

  // Riparte dal punto giusto se la pagina viene ricaricata a metà scroll
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
