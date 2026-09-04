#!/usr/bin/env python3
# Icone du raccourci bureau : DYNAMIQUE (degrade ADBI magenta -> orange) avec
# un document blanc et une fleche ascendante (mouvement / momentum).
# Multi-resolutions pour Windows.
import sys
from PIL import Image, ImageDraw, ImageFilter

MAGENTA = (200, 30, 120)   # #C81E78
ORANGE  = (242, 106, 33)   # #F26A21
WHITE   = (255, 255, 255)
TINT    = (250, 205, 225)  # lignes de texte (magenta clair)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def diag_gradient(S, c1, c2):
    """Degrade diagonal (haut-gauche -> bas-droite)."""
    grad = Image.new("RGBA", (S, S))
    px = grad.load()
    for y in range(S):
        ty = y / (S - 1)
        for x in range(S):
            t = (x / (S - 1) + ty) / 2
            px[x, y] = lerp(c1, c2, t) + (255,)
    return grad


def make(size):
    S = size * 4  # supersampling
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # Fond : carre arrondi a degrade diagonal magenta -> orange.
    m = int(S * 0.05)
    grad = diag_gradient(S, MAGENTA, ORANGE)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([m, m, S - m, S - m], radius=int(S * 0.23), fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)

    # Document blanc (coin superieur droit plie), legerement a gauche.
    px0, py0 = int(S * 0.255), int(S * 0.235)
    px1, py1 = int(S * 0.635), int(S * 0.775)
    fold = int((px1 - px0) * 0.30)
    body = [(px0, py0), (px1 - fold, py0), (px1, py0 + fold), (px1, py1), (px0, py1)]
    d.polygon(body, fill=WHITE + (255,))
    # pli (petit triangle translucide)
    d.polygon([(px1 - fold, py0), (px1 - fold, py0 + fold), (px1, py0 + fold)], fill=TINT + (255,))
    # lignes de texte
    lh = max(2, int(S * 0.024))
    lx0 = px0 + int(S * 0.05)
    for i, w in enumerate((0.22, 0.16)):
        ly = int(S * (0.375 + i * 0.085))
        d.rounded_rectangle([lx0, ly, lx0 + int(S * w), ly + lh], radius=lh // 2, fill=TINT + (255,))

    # Fleche ascendante (mouvement) : trait blanc epais + ombre douce, montant vers le haut-droite.
    pts = [(int(S * 0.34), int(S * 0.66)),
           (int(S * 0.50), int(S * 0.57)),
           (int(S * 0.62), int(S * 0.62)),
           (int(S * 0.78), int(S * 0.40))]
    sw = max(3, int(S * 0.05))
    # ombre
    sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(sh).line([(x + int(S * 0.006), y + int(S * 0.006)) for x, y in pts],
                            fill=(90, 10, 45, 120), width=sw, joint="curve")
    sh = sh.filter(ImageFilter.GaussianBlur(int(S * 0.01)))
    img.alpha_composite(sh)
    d = ImageDraw.Draw(img)
    d.line(pts, fill=WHITE + (255,), width=sw, joint="curve")
    # pointe de fleche
    ex, ey = pts[-1]
    a = int(S * 0.075)
    d.line([(ex - a, ey + int(a * 0.15)), (ex, ey), (ex - int(a * 0.15), ey + a)],
           fill=WHITE + (255,), width=sw, joint="curve")

    return img.resize((size, size), Image.LANCZOS)


sizes = [16, 24, 32, 48, 64, 128, 256]
imgs = [make(s) for s in sizes]
out = sys.argv[1] if len(sys.argv) > 1 else "icone.ico"
imgs[0].save(out, format="ICO", sizes=[(s, s) for s in sizes], append_images=imgs[1:])
if len(sys.argv) > 2:
    make(256).save(sys.argv[2])
print("icone generee :", out, sizes)
