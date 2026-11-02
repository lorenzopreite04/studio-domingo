// Strumento temporaneo di diagnosi: si carica solo con ?debug nell'indirizzo.
// Disegna una linea colorata per ogni modo di misurare l'altezza dello schermo e un
// riquadro con i numeri, così da uno screenshot del telefono si vede quale coincide con
// il bordo davvero visibile. Da rimuovere a diagnosi finita.
(() => {
  const css = (el, props) => Object.assign(el.style, props);
  const box = (props) => {
    const el = document.createElement('div');
    css(el, { position: 'fixed', zIndex: '9999', pointerEvents: 'none', ...props });
    document.body.append(el);
    return el;
  };

  // Sonde invisibili: la loro altezza dice quanti px vale ogni unità
  const probe = (height) => box({ top: '0', left: '0', width: '1px', height, visibility: 'hidden' });
  const probes = { svh: probe('100svh'), lvh: probe('100lvh'), dvh: probe('100dvh'), vh: probe('100vh') };
  const insets = box({ top: '0', left: '0', width: '1px', visibility: 'hidden',
    paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' });
  const fixedFull = box({ top: '0', bottom: '0', left: '0', width: '1px', visibility: 'hidden' });

  // Linee: ognuna con la sua etichetta, in colonne diverse per non sovrapporsi
  const LINES = [
    { id: 'svh', color: '#ff2d55', left: '0%' },
    { id: 'dvh', color: '#34c759', left: '20%' },
    { id: 'lvh', color: '#ffcc00', left: '40%' },
    { id: 'fixed', color: '#00c7ff', left: '60%' },
    { id: 'inner', color: '#ff00ff', left: '80%' },
  ].map((l) => {
    const line = box({ left: '0', right: '0', height: '3px', background: l.color });
    const label = box({ left: l.left, padding: '1px 4px', font: 'bold 11px/1.2 monospace', color: '#000', background: l.color });
    label.textContent = l.id;
    return { ...l, line, label };
  });

  const panel = box({ top: '140px', left: '8px', right: '8px', padding: '8px',
    font: '12px/1.35 monospace', color: '#fff', background: 'rgba(0,0,0,0.82)', borderRadius: '8px', whiteSpace: 'pre-wrap' });

  const r = (n) => Math.round(n);

  function update() {
    const h = { svh: probes.svh.offsetHeight, lvh: probes.lvh.offsetHeight, dvh: probes.dvh.offsetHeight,
      fixed: fixedFull.offsetHeight, inner: window.innerHeight };
    for (const l of LINES) {
      css(l.line, { top: `${h[l.id] - 3}px` });
      css(l.label, { top: `${h[l.id] - 18}px` });
    }

    const pad = getComputedStyle(insets);
    const vv = window.visualViewport;
    const sticky = document.querySelector('.scroll-video__sticky')?.getBoundingClientRect();
    const scene = [...document.querySelectorAll('[data-scene]')]
      .reduce((best, s) => (+s.style.opacity > +(best?.style.opacity || 0) ? s : best), null);
    const sceneBox = scene?.getBoundingClientRect();
    const p = scene?.querySelector('.scene__panel, .hero__body');
    const pBox = p?.getBoundingClientRect();

    panel.textContent = [
      `schermo ${screen.width}x${screen.height}  finestra ${window.innerWidth}x${window.innerHeight}`,
      `100vh ${probes.vh.offsetHeight}  svh ${h.svh}  dvh ${h.dvh}  lvh ${h.lvh}`,
      `fixed inset:0 ${h.fixed}  clientHeight ${document.documentElement.clientHeight}`,
      `visualViewport ${vv ? `${r(vv.height)} (offsetTop ${r(vv.offsetTop)})` : '-'}`,
      `safe-area top ${pad.paddingTop}  bottom ${pad.paddingBottom}`,
      `video sticky top ${sticky ? r(sticky.top) : '-'} alto ${sticky ? r(sticky.height) : '-'}`,
      `scena ${scene?.dataset.scene || '-'} ${sceneBox ? `${r(sceneBox.top)}→${r(sceneBox.bottom)}` : ''}`,
      `pannello ${pBox ? `${r(pBox.top)}→${r(pBox.bottom)}  scorre dentro ${p.scrollHeight - p.clientHeight}px` : '-'}`,
      navigator.userAgent.replace(/^Mozilla\/5\.0 /, ''),
    ].join('\n');
  }

  update();
  setInterval(update, 300);
  window.addEventListener('resize', update);
})();
