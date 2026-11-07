"""Genera los iconos de Nyvo (web, PWA, iOS) a partir de design/logo-source.png.

Uso (solo desarrollo, no forma parte del build):  python3 design/make-icons.py
Requiere Pillow. Los resultados se guardan en web/public/ y se suben al repositorio.

El logo original mide 387×397 px y es opaco (fondo azul marino): los iconos de 512 px son
una ampliación ligera. Para más nitidez, sustituye logo-source.png por una versión de
1024 px o más y vuelve a ejecutar el script.
"""
from pathlib import Path
from statistics import median

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "public"
OUT.mkdir(parents=True, exist_ok=True)

src = Image.open(ROOT / "design" / "logo-source.png").convert("RGB")
w, h = src.size
side = min(w, h)
left, top = (w - side) // 2, (h - side) // 2
square = src.crop((left, top, left + side, top + side))


def border_color(im: Image.Image) -> tuple[int, int, int]:
    """Color típico del borde (mediana), para rellenar fondos que no deben notarse."""
    px = im.load()
    n = im.size[0]
    samples = [px[i, 0] for i in range(n)] + [px[i, n - 1] for i in range(n)] \
        + [px[0, i] for i in range(n)] + [px[n - 1, i] for i in range(n)]
    return tuple(int(median(c[k] for c in samples)) for k in range(3))  # type: ignore[return-value]


def resized(size: int) -> Image.Image:
    return square.resize((size, size), Image.Resampling.LANCZOS)


def maskable(size: int, inner_ratio: float = 0.66) -> Image.Image:
    """Icono «maskable» (Android): el logo queda dentro de la zona segura (centro ~80 %)."""
    bg = Image.new("RGB", (size, size), border_color(square))
    inner_size = round(size * inner_ratio)
    inner = square.resize((inner_size, inner_size), Image.Resampling.LANCZOS)
    feather = max(2, round(inner_size * 0.035))
    mask = Image.new("L", (inner_size, inner_size), 0)
    ImageDraw.Draw(mask).rectangle(
        (feather, feather, inner_size - feather, inner_size - feather), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(feather / 1.5))
    off = (size - inner_size) // 2
    bg.paste(inner, (off, off), mask)
    return bg


def save_png(im: Image.Image, name: str) -> None:
    path = OUT / name
    im.save(path, optimize=True)
    print(f"{name:26s} {im.size[0]}x{im.size[1]}  {path.stat().st_size / 1024:.0f} KB")


save_png(resized(512), "icon-512.png")
save_png(resized(192), "icon-192.png")
save_png(maskable(512), "icon-maskable-512.png")
save_png(maskable(192), "icon-maskable-192.png")
save_png(resized(180), "apple-touch-icon.png")
save_png(resized(32), "favicon-32.png")
save_png(resized(96), "logo-96.png")
save_png(resized(256), "logo-256.png")

# favicon.ico con 16, 32 y 48 px
ico = OUT / "favicon.ico"
resized(256).save(ico, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
print(f"favicon.ico                16/32/48  {ico.stat().st_size / 1024:.0f} KB")

r, g, b = border_color(square)
print(f"color de borde: #{r:02x}{g:02x}{b:02x}")
