"""Rigenera i fotogrammi dello sfondo a partire da un video.

Uso (una volta sola: pip install imageio-ffmpeg):
    python strumenti/estrai-frame.py _sorgenti/video-sfondo.mp4

Crea assets/frames/desktop (tutti i fotogrammi) e assets/frames/mobile (uno su due),
entrambi in WebP 1600 px di larghezza. Alla fine stampa quanti fotogrammi ha ogni set:
quei numeri vanno copiati in FRAME_SETS dentro js/scroll-video.js, e le keyframe in
TIMELINE vanno ricontrollate (i numeri di fotogramma delle sezioni).
"""
import shutil
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg

ROOT = Path(__file__).resolve().parent.parent
FRAMES = ROOT / "assets" / "frames"

SETS = {
    "desktop": ["-vf", "scale=1600:-2", "-quality", "72"],
    "mobile": ["-vf", "select='not(mod(n\\,2))',scale=1600:-2", "-fps_mode", "vfr", "-quality", "60"],
}

# Fotogrammi su cui si fermano le sezioni (gli stessi di TIMELINE in js/scroll-video.js):
# restano a schermo a lungo, quindi vengono salvati con una qualità più alta
KEYFRAMES = [0, 82, 278, 408, 552]
KEYFRAME_QUALITY = "90"


def encode(ffmpeg, video, args, target):
    subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video), *args,
         "-c:v", "libwebp", "-compression_level", "6", str(target)],
        check=True,
    )


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    video = Path(sys.argv[1])
    if not video.is_file():
        sys.exit(f"Video non trovato: {video}")

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    counts = {}
    for name, args in SETS.items():
        out = FRAMES / name
        shutil.rmtree(out, ignore_errors=True)
        out.mkdir(parents=True)
        encode(ffmpeg, video, args, out / "frame_%04d.webp")
        counts[name] = len(list(out.glob("frame_*.webp")))

    # Ogni keyframe nel set mobile è il fotogramma più vicino tra quelli tenuti (uno su due)
    step = (counts["desktop"] - 1) / (counts["mobile"] - 1)
    for frame in KEYFRAMES:
        mobile_index = round(frame / step)
        for name, index, source in (("desktop", frame, frame), ("mobile", mobile_index, mobile_index * 2)):
            encode(ffmpeg, video,
                   ["-vf", f"select='eq(n\\,{source})',scale=1600:-2", "-frames:v", "1", "-quality", KEYFRAME_QUALITY],
                   FRAMES / name / f"frame_{index + 1:04d}.webp")

    for name, count in counts.items():
        size = sum(f.stat().st_size for f in (FRAMES / name).iterdir()) / 1024 / 1024
        print(f"{name}: {count} fotogrammi, {size:.1f} MB  ->  FRAME_SETS.{name}.count = {count}")


if __name__ == "__main__":
    main()
