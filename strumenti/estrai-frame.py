"""Rigenera i fotogrammi dello sfondo a partire da un video.

Uso (una volta sola: pip install imageio-ffmpeg pillow):
    python strumenti/estrai-frame.py _sorgenti/video-sfondo.mp4

Crea due set in WebP, con lo stesso numero di fotogrammi:
- assets/frames/desktop: il video intero, 1600 px di larghezza;
- assets/frames/mobile: per i telefoni in verticale, già inquadrati in 600x900. Un telefono
  vede solo una striscia del video: invece di scaricare e decodificare ogni volta il
  fotogramma intero, qui si salva solo la parte che serve, centrata sul soggetto della scena
  (`focus`) e, se serve, rimpicciolita (`zoom`). Così pesa e si decodifica ~3 volte meno.

I fotogrammi su cui si fermano le sezioni restano a schermo a lungo: vengono salvati con
qualità più alta e, nel set mobile, al doppio della risoluzione e con più nitidezza.

Alla fine stampa quanti fotogrammi ha ogni set: quel numero va copiato in FRAME_SETS dentro
js/scroll-video.js, e le keyframe qui sotto devono restare le stesse di TIMELINE lì.
"""
import re
import shutil
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
FRAMES = ROOT / "assets" / "frames"

DESKTOP_WIDTH = 1600
DESKTOP_QUALITY = "72"
MOBILE_SIZE = (600, 900)
MOBILE_QUALITY = 62
KEYFRAME_QUALITY = 90

# Fotogrammi su cui si fermano le sezioni (gli stessi di TIMELINE in js/scroll-video.js) e
# inquadratura sui telefoni, interpolata tra una keyframe e l'altra:
# - focus: punto orizzontale del video da tenere al centro (0 = bordo sinistro, 1 = destro)
# - zoom: 1 = il video riempie l'altezza dello schermo; meno di 1 = rimpicciolito, per far
#   stare il soggetto tra il titolo e il riquadro (lo spazio sopra/sotto viene riempito
#   allungando il bordo del fotogramma, che in queste scene è sfondo uniforme)
# - y: con zoom < 1, dove sta il video in verticale (0 = in alto, 1 = in basso)
KEYFRAMES = [
    {"frame": 0, "focus": 0.5, "zoom": 1, "y": 0.5},
    {"frame": 82, "focus": 0.51, "zoom": 0.7, "y": 0},
    {"frame": 278, "focus": 0.25, "zoom": 1, "y": 0.5},
    {"frame": 408, "focus": 0.72, "zoom": 1, "y": 0.5},
    {"frame": 552, "focus": 0.26, "zoom": 1, "y": 0.5},
]
KEY_FRAMES = {k["frame"] for k in KEYFRAMES}


def framing(index):
    """Inquadratura mobile del fotogramma `index`, interpolata linearmente tra le keyframe."""
    for prev, nxt in zip(KEYFRAMES, KEYFRAMES[1:]):
        if index <= nxt["frame"]:
            r = max(0.0, (index - prev["frame"]) / (nxt["frame"] - prev["frame"]))
            return {p: prev[p] + (nxt[p] - prev[p]) * r for p in ("focus", "zoom", "y")}
    return {p: KEYFRAMES[-1][p] for p in ("focus", "zoom", "y")}


def extend_vertically(img, y0, region_h, feather=90):
    """Allunga il fotogramma sopra e/o sotto (dove il ritaglio esce dal video) con il colore
    medio delle righe di bordo, molto sfocato; il video ci sfuma dentro senza stacchi netti."""
    w, h = img.size
    pad = int(region_h - h) + 2
    top_visible, bottom_visible = y0 < 0, y0 + region_h > h

    def fill(band, height):
        row = img.crop(band).resize((w, 1), Image.BOX).filter(ImageFilter.BoxBlur(w // 6))
        return row.resize((w, height))

    top_fill = fill((0, 0, w, 40), pad)
    bottom_fill = fill((0, h - 40, w, h), pad)

    # Sotto il video: colore di bordo, così dove sfuma non si vede il nero
    base = Image.new("RGB", (w, h))
    base.paste(top_fill.resize((w, h // 2)), (0, 0))
    base.paste(bottom_fill.resize((w, h - h // 2)), (0, h // 2))
    alpha = [255] * h
    for i in range(feather):
        a = int(255 * i / feather)
        if top_visible:
            alpha[i] = min(alpha[i], a)
        if bottom_visible:
            alpha[h - 1 - i] = min(alpha[h - 1 - i], a)
    mask = Image.new("L", (1, h))
    mask.putdata(alpha)
    base.paste(img, (0, 0), mask.resize((w, h)))

    tall = Image.new("RGB", (w, h + 2 * pad))
    tall.paste(top_fill, (0, 0))
    tall.paste(base, (0, pad))
    tall.paste(bottom_fill, (0, pad + h))
    return tall, y0 + pad


def mobile_frame(img, f, scale):
    """Ritaglio 600x900 (x `scale`) del fotogramma intero secondo l'inquadratura `f`."""
    w, h = img.size
    out_w, out_h = MOBILE_SIZE
    # Porzione del video che finisce nel ritaglio: alta quanto il video diviso lo zoom
    region_h = h / f["zoom"]
    region_w = region_h * out_w / out_h
    x0 = min(max(f["focus"] * w - region_w / 2, 0), w - region_w)
    y0 = (h - region_h) * f["y"]

    if region_h > h:
        img, y0 = extend_vertically(img, y0, region_h)

    size = (round(out_w * scale), round(out_h * scale))
    return img.resize(size, Image.LANCZOS, box=(x0, y0, x0 + region_w, y0 + region_h))


def video_size(ffmpeg, video):
    probe = subprocess.run([ffmpeg, "-hide_banner", "-i", str(video)], capture_output=True, text=True)
    match = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", probe.stderr)
    if not match:
        sys.exit("Impossibile leggere la risoluzione del video")
    return int(match.group(1)), int(match.group(2))


def extract_desktop(ffmpeg, video, out):
    subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
         "-vf", f"scale={DESKTOP_WIDTH}:-2", "-c:v", "libwebp", "-quality", DESKTOP_QUALITY,
         "-compression_level", "6", str(out / "frame_%04d.webp")],
        check=True,
    )
    for frame in KEY_FRAMES:
        subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
             "-vf", f"select='eq(n\\,{frame})',scale={DESKTOP_WIDTH}:-2", "-frames:v", "1",
             "-c:v", "libwebp", "-quality", str(KEYFRAME_QUALITY), "-compression_level", "6",
             str(out / f"frame_{frame + 1:04d}.webp")],
            check=True,
        )


def extract_mobile(ffmpeg, video, out):
    w, h = video_size(ffmpeg, video)
    frame_bytes = w * h * 3
    proc = subprocess.Popen(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(video),
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    index = 0
    while True:
        data = proc.stdout.read(frame_bytes)
        if len(data) < frame_bytes:
            break
        img = Image.frombytes("RGB", (w, h), data)
        f = framing(index)
        if index in KEY_FRAMES:
            frame = mobile_frame(img, f, 2).filter(ImageFilter.UnsharpMask(radius=2.4, percent=90, threshold=2))
            quality = KEYFRAME_QUALITY
        else:
            frame = mobile_frame(img, f, 1).filter(ImageFilter.UnsharpMask(radius=1.2, percent=35, threshold=3))
            quality = MOBILE_QUALITY
        frame.save(out / f"frame_{index + 1:04d}.webp", quality=quality, method=6)
        index += 1
    proc.wait()


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    video = Path(sys.argv[1])
    if not video.is_file():
        sys.exit(f"Video non trovato: {video}")

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    for name, extract in (("desktop", extract_desktop), ("mobile", extract_mobile)):
        out = FRAMES / name
        shutil.rmtree(out, ignore_errors=True)
        out.mkdir(parents=True)
        extract(ffmpeg, video, out)
        files = list(out.glob("frame_*.webp"))
        size = sum(f.stat().st_size for f in files) / 1024 / 1024
        print(f"{name}: {len(files)} fotogrammi, {size:.1f} MB  ->  FRAME_SETS.{name}.count = {len(files)}")


if __name__ == "__main__":
    main()
