// Caricato nel <head> prima del rendering: toglie il layout di ripiego per chi non ha
// JavaScript e blocca lo scroll finché la schermata di caricamento è visibile
document.documentElement.classList.replace('no-js', 'is-loading');

// Paracadute: se js/scroll-video.js non partisse (file bloccato, errore), la schermata di
// caricamento non deve restare per sempre a coprire il sito
setTimeout(() => {
  document.documentElement.classList.remove('is-loading');
  document.getElementById('site-loader')?.classList.add('is-done');
}, 20000);
