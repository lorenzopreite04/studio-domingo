# Studio Dentistico Domingo — sito web

Sito di una sola pagina con video di sfondo guidato dallo scroll: scorrendo, il video avanza
fotogramma per fotogramma e su cinque fotogrammi chiave compaiono le sezioni
(Benvenuti, Hero, Chi siamo, Servizi, Contatti). È HTML, CSS e JavaScript puro:
nessun framework, nessuna compilazione.

## Struttura

```
index.html            pagina principale
privacy.html          informativa privacy (bozza da completare)
cookie.html           cookie policy
404.html              pagina "non trovata"
css/style.css         stile del sito
css/fonts.css         font ospitati in locale (Archivo, Figtree)
css/page.css          stile delle pagine di testo (privacy, cookie, 404)
js/scroll-video.js    motore del video: fotogrammi, timeline, schermata di caricamento, scorrimento animato
js/no-js.js           segnala che JavaScript è attivo (va caricato prima del resto)
js/site.js            sezioni, menu, schede servizi, modulo di prenotazione
assets/frames/        fotogrammi del video (desktop e mobile: 553 ciascuno)
assets/fonts/         file dei font
assets/og-image.jpg   anteprima per social e WhatsApp
favicon.svg, favicon-32.png, apple-touch-icon.png
robots.txt, sitemap.xml
strumenti/            script per rigenerare i fotogrammi (non va pubblicato)
_sorgenti/            video originale (non va pubblicato)
```

## Provarlo sul computer

Serve un piccolo server locale (aprire `index.html` con doppio clic funziona, ma alcuni
browser bloccano il caricamento dei fotogrammi da file):

```
python -m http.server 5173
```

poi aprire http://localhost:5173

## Cosa personalizzare

Tutti i dati segnaposto contengono `Esempio`, `.example`, `000` o
`[parentesi quadre]`: cercandoli nei file si trovano tutti. L'email è su un dominio `.example`,
riservato e che non riceve posta, così le richieste di prova della demo non finiscono a nessuno.

Il sito ora è una demo: ha `noindex` (in `index.html` e come `X-Robots-Tag` in `vercel.json`),
quindi Google non lo mostra nei risultati. Per uno studio reale vanno tolti entrambi.

| Cosa | Dove |
|---|---|
| Titolo della hero ("ESEMPIO") | `index.html`, `<h2 id="hero-title">` |
| Indirizzo, telefono, email, orari | `index.html` (sezione Contatti, modulo, dati strutturati `application/ld+json`), `privacy.html`, `cookie.html`, `js/site.js` (`BOOKING`) |
| Città nel titolo della pagina | `index.html`, `<title>` e `<meta name="description">` |
| Numeri di "Chi siamo" (anni, specialisti, pazienti) | `index.html`, `<ul class="stats">` |
| P.IVA, direttore sanitario, iscrizione all'Albo | `index.html` (footer), `privacy.html`, `cookie.html` |
| Dominio del sito | `index.html` (`canonical`, `og:`, dati strutturati), `robots.txt`, `sitemap.xml` |
| Link "Indicazioni" su Google Maps | `index.html`, sezione Contatti |

## Modulo di prenotazione

In `js/site.js`, oggetto `BOOKING`:

- `endpoint` vuoto (com'è ora): alla conferma si apre il programma di posta del paziente
  con un'email già compilata per `BOOKING.email`. Funziona subito, ma il paziente deve
  premere "Invia" nella sua app di posta.
- `endpoint` compilato: la richiesta parte direttamente dal sito. Va creato un modulo su un
  servizio come [Formspree](https://formspree.io), [Web3Forms](https://web3forms.com) o
  Netlify Forms e incollato qui l'URL che forniscono. Il campo nascosto `_gotcha` blocca i bot.
  Il dominio del servizio va aggiunto a `connect-src` nella Content-Security-Policy di
  `vercel.json` (es. `connect-src 'self' https://formspree.io`).

## Cambiare il video di sfondo

```
pip install imageio-ffmpeg pillow
python strumenti/estrai-frame.py percorso/nuovo-video.mp4
```

Lo script crea due set di fotogrammi:

- **desktop**: il video intero, 1600 px di larghezza;
- **mobile**: per i telefoni in verticale, già ritagliati (600x900) sul soggetto di ogni scena,
  così pesano e si decodificano circa 3 volte meno e lo scroll resta fluido.

I fotogrammi su cui si fermano le sezioni sono salvati con qualità più alta (e su mobile al
doppio della risoluzione). L'inquadratura sui telefoni si regola in `KEYFRAMES` dentro lo
script:

- `focus`: punto da tenere al centro (0 = bordo sinistro, 1 = destro);
- `zoom`: meno di 1 per rimpicciolire il video, come nella hero;
- `y`: posizione verticale del video quando è rimpicciolito.

Dopo aver rigenerato i fotogrammi:

1. aggiornare in `js/scroll-video.js` il numero di fotogrammi (`FRAME_SETS`) e, se cambiano, i
   fotogrammi delle sezioni in `TIMELINE`, che devono restare uguali a `KEYFRAMES` dello script;
2. aumentare `FRAME_VERSION` in `js/scroll-video.js` e il `?v=` dei due `<link rel="preload">`
   in `index.html`: i fotogrammi restano nella cache dei browser per una settimana, e senza
   questo chi ha già visitato il sito vedrebbe un misto di vecchi e nuovi.

## Pubblicazione

Il sito è su GitHub e Vercel lo pubblica da solo a ogni `git push` sul ramo `main`.

- `.gitignore`: cosa non va su GitHub (video originale, impostazioni locali).
- `.vercelignore`: cosa sta su GitHub ma non viene pubblicato (README, strumenti).
- `vercel.json`: intestazioni di sicurezza (HTTPS obbligatorio, Content-Security-Policy che
  permette solo file di questo sito, blocco dell'inserimento in iframe di altri siti) e cache
  di una settimana per immagini e font. Vercel usa da solo `404.html` per le pagine inesistenti.

Con un altro hosting: caricare tutto **tranne** `_sorgenti/`, `strumenti/`, `.claude/` e
`README.md`, attivare HTTPS e ricreare le intestazioni di `vercel.json` nel formato di
quell'hosting.
