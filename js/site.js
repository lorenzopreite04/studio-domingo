(() => {
  const SV = window.ScrollVideo;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

  // --- Scene sincronizzate con il video ---------------------------------------

  const header = document.getElementById('site-header');
  const nextBtn = document.getElementById('next-btn');
  const ring = nextBtn.querySelector('circle');
  const RING_LENGTH = 2 * Math.PI * 22;
  const sceneLinks = document.querySelectorAll('.nav__link[data-scene-link], .menu__link[data-scene-link]');
  const hero = SV.keys.find((k) => k.id === 'hero');
  // Ogni elemento animato ricorda l'ultimo stato scritto: update() gira a ogni fotogramma
  // dello scroll e toccare il DOM quando non cambia niente costa (ricalcolo degli stili)
  const animated = (el) => ({ el, opacity: -1, transform: null, active: null });
  const scenes = SV.keys.map((key) => ({ key, ...animated(document.querySelector(`[data-scene="${key.id}"]`)) }));
  const headerState = animated(header);
  // Spostamento verticale (px) delle scene mentre compaiono/spariscono
  const SHIFT = reducedMotion ? 0 : 36;

  let currentPos = 0;
  let activeId = null;
  let lastNext;

  function setVisibility(item, opacity, transform) {
    const { el } = item;
    if (opacity !== item.opacity) {
      if (item.opacity === -1 || (opacity === 0) !== (item.opacity === 0)) {
        el.style.visibility = opacity === 0 ? 'hidden' : 'visible';
      }
      el.style.opacity = opacity;
      item.opacity = opacity;
    }
    if (transform !== item.transform) {
      el.style.transform = transform;
      item.transform = transform;
    }
    // Solo una scena (quasi) del tutto visibile è cliccabile e raggiungibile da tastiera
    const active = opacity > 0.6;
    if (active !== item.active) {
      el.inert = !active;
      el.classList.toggle('is-active', active);
      item.active = active;
    }
  }

  function update(pos) {
    currentPos = pos;
    let best = null;

    for (const scene of scenes) {
      const o = SV.keyOpacity(scene.key, pos);
      const dir = pos < scene.key.start ? 1 : -1;
      setVisibility(scene, o, o > 0 && o < 1 ? `translate3d(0, ${((1 - o) * SHIFT * dir).toFixed(1)}px, 0)` : '');
      if (!best || o > best.o) best = { id: scene.key.id, o };
    }

    // L'header compare insieme alla hero e poi resta
    const from = hero.start - hero.fadeIn;
    const h = hero.fadeIn ? clamp01((pos - from) / hero.fadeIn) : pos >= hero.start ? 1 : 0;
    setVisibility(headerState, h, h < 1 ? `translate3d(0, ${((h - 1) * 16).toFixed(1)}px, 0)` : '');

    if (best.id !== activeId) {
      activeId = best.id;
      sceneLinks.forEach((a) => {
        if (a.dataset.sceneLink === activeId) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      });
    }

    ring.style.strokeDashoffset = (RING_LENGTH * (1 - pos / SV.length)).toFixed(1);
    const next = nextKey(pos);
    if (next !== lastNext) {
      lastNext = next;
      nextBtn.classList.toggle('is-last', !next);
      nextBtn.setAttribute('aria-label', next ? 'Sezione successiva' : "Torna all'inizio");
    }
  }

  // Prima scena il cui punto di arrivo (metà della pausa; il benvenuto in cima) è più avanti
  const nextKey = (pos) => SV.keys.find((k, i) => (i === 0 ? 0 : k.start + k.hold / 2) > pos + 1);

  nextBtn.addEventListener('click', () => {
    const next = nextKey(currentPos);
    if (next) SV.scrollToKey(next.id);
    else SV.scrollTo(0);
  });

  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-scene-link]');
    if (!link) return;
    e.preventDefault();
    const dialog = link.closest('dialog');
    if (dialog) dialog.close();
    if (link.dataset.sceneLink === 'intro') SV.scrollTo(0);
    else SV.scrollToKey(link.dataset.sceneLink);
  });

  SV.subscribe(update);

  // Link diretti a una sezione (es. index.html#scene-services)
  const deepLink = [...document.querySelectorAll('[data-scene-link]')].find((a) => a.getAttribute('href') === location.hash);
  if (deepLink) SV.scrollToKey(deepLink.dataset.sceneLink, true);

  // --- Tab dei servizi (frecce sinistra/destra per spostarsi, come da pattern ARIA) ------

  document.querySelectorAll('[data-tabs]').forEach((tabsEl) => {
    const tabs = [...tabsEl.querySelectorAll('[role="tab"]')];

    const select = (tab) => {
      tabs.forEach((t) => {
        const selected = t === tab;
        t.setAttribute('aria-selected', String(selected));
        t.tabIndex = selected ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !selected;
      });
    };

    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab));
      tab.addEventListener('keydown', (e) => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (!step) return;
        const next = tabs[(i + step + tabs.length) % tabs.length];
        next.focus();
        select(next);
      });
    });
  });

  // --- Dialog: menu mobile e prenotazione ---------------------------------------------

  function openDialog(id) {
    const dialog = document.getElementById(id);
    if (!dialog || dialog.open) return;
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    dialog.showModal();
    document.documentElement.classList.add('is-locked');
  }

  document.querySelectorAll('dialog').forEach((dialog) => {
    dialog.addEventListener('close', () => {
      if (!document.querySelector('dialog[open]')) document.documentElement.classList.remove('is-locked');
    });
    // Click sullo sfondo scuro: chiude
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  });

  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-dialog-open]');
    if (opener) {
      openDialog(opener.dataset.dialogOpen);
      // "Prenota" di un trattamento: lo preseleziona nel modulo di prenotazione
      const treatment = document.querySelector(`#${opener.dataset.dialogOpen} [name="treatment"]`);
      if (treatment) treatment.value = opener.dataset.treatment || treatment.options[0].value;
    }
    const closer = e.target.closest('[data-dialog-close]');
    if (closer) closer.closest('dialog').close();
  });

  // --- Modulo di prenotazione -----------------------------------------------------------

  // DA CONFIGURARE. `endpoint`: URL fornito da un servizio di moduli (es. Formspree,
  // Web3Forms, Netlify Forms) che inoltra le richieste via email allo studio. Il suo
  // dominio va aggiunto anche a `connect-src` nella Content-Security-Policy di vercel.json,
  // altrimenti il browser blocca l'invio.
  // Finché resta vuoto, la richiesta viene preparata come email nel programma di posta
  // del paziente, indirizzata a `email` (`.example` è un dominio riservato che non riceve
  // posta: va sostituito con l'indirizzo reale dello studio).
  const BOOKING = {
    endpoint: '',
    email: 'info@studiodomingo.example',
    phone: '+39 000 000 0000',
  };

  const LABELS = {
    name: 'Nome e cognome',
    phone: 'Telefono',
    email: 'Email',
    treatment: 'Motivo della visita',
    date: 'Data preferita',
    time: 'Fascia oraria',
  };

  const today = new Date();
  const isoToday = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  document.querySelectorAll('[data-min-today]').forEach((input) => (input.min = isoToday));

  function bookingText(data) {
    return Object.entries(LABELS)
      .map(([key, label]) => {
        let value = data.get(key) || '';
        if (key === 'date' && value) value = new Date(`${value}T12:00`).toLocaleDateString('it-IT');
        return `${label}: ${value}`;
      })
      .join('\n');
  }

  document.querySelectorAll('[data-booking-form]').forEach((form) => {
    const status = form.querySelector('[data-form-status]');
    const submit = form.querySelector('[type="submit"]');
    const setStatus = (text, state) => {
      status.textContent = text;
      status.dataset.state = state || '';
    };

    // L'evento submit arriva solo se i campi obbligatori sono validi (controllo nativo del browser)
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const success = "Richiesta inviata! Ti richiameremo per confermare l'appuntamento.";

      // Bot che ha compilato il campo trappola: finto successo, nessun invio
      if (data.get('_gotcha')) {
        setStatus(success, 'ok');
        form.reset();
        return;
      }

      if (!BOOKING.endpoint) {
        const subject = `Richiesta appuntamento – ${data.get('name')}`;
        window.location.href = `mailto:${BOOKING.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bookingText(data))}`;
        setStatus("Abbiamo preparato un'email con la tua richiesta: inviala dal tuo programma di posta.", 'ok');
        return;
      }

      submit.disabled = true;
      setStatus('Invio in corso…');
      try {
        data.delete('_gotcha');
        const res = await fetch(BOOKING.endpoint, {
          method: 'POST',
          body: data,
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(String(res.status));
        setStatus(success, 'ok');
        form.reset();
      } catch {
        setStatus(`Invio non riuscito. Riprova oppure chiamaci al ${BOOKING.phone}.`, 'error');
      } finally {
        submit.disabled = false;
      }
    });

    form.addEventListener('input', () => setStatus(''));
  });
})();
