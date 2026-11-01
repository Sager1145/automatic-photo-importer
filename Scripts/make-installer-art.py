# Renders the branded MSI dialog artwork (WixUIDialogBmp 493x312 and WixUIBannerBmp 493x58) from the app icon.
# The outputs are committed in Assets/Installer, so packaging does not need Python; rerun after changing the icon.
#   python Scripts/make-installer-art.py
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "Assets" / "Installer"
ICON = Image.open(ROOT / "Assets" / "AppIcon-preview.png").convert("RGBA")
FONT = ROOT / "Assets" / "Fonts" / "InterVariable.ttf"
CREAM = (255, 250, 243)
TOP, BOTTOM = (240, 138, 104), (203, 64, 51)  # icon's light orange down to the app's --accent-fill
SCALE = 3  # draw large, then downsample for smooth edges


def font(size, weight):
    f = ImageFont.truetype(str(FONT), size * SCALE)
    f.set_variation_by_axes([min(max(size, 14), 32), weight])  # axes: optical size, weight
    return f


def gradient(w, h):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        c = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
        for x in range(w):
            px[x, y] = c
    return img


def icon(size):
    # Crop the transparent margin so the rounded square fills the requested size.
    return ICON.crop(ICON.getbbox()).resize((size, size), Image.LANCZOS)


def dialog():
    # Welcome/Finish dialogs: WiX draws its text from x≈165, so the brand panel stays in the left 164 px.
    w, h, panel = 493 * SCALE, 312 * SCALE, 164 * SCALE
    img = Image.new("RGB", (w, h), CREAM)
    side = gradient(panel, h).convert("RGBA")
    # Faint rings behind the icon, drawn on the panel only so they never reach the text area.
    glow = Image.new("RGBA", side.size)
    cx, cy = panel // 2, int(h * 0.34)
    for r, a in ((118, 34), (86, 52), (64, 80)):
        r *= SCALE
        ImageDraw.Draw(glow).ellipse((cx - r, cy - r, cx + r, cy + r), outline=(255, 255, 255, a), width=SCALE)
    side = Image.alpha_composite(side, glow)
    # A cream tile lifts the orange icon off the orange panel.
    tile = 84 * SCALE
    ImageDraw.Draw(side).rounded_rectangle((cx - tile // 2, cy - tile // 2, cx + tile // 2, cy + tile // 2),
                                           radius=22 * SCALE, fill=(255, 246, 236))
    ic = icon(68 * SCALE)
    side.alpha_composite(ic, (cx - ic.width // 2, cy - ic.height // 2))
    img.paste(side.convert("RGB"), (0, 0))
    d = ImageDraw.Draw(img)
    for text, size, weight, y in (("Automatic", 16, 700, 0.60), ("Photo Importer", 16, 700, 0.67),
                                  ("Verified imports.", 10, 500, 0.82), ("Nothing deleted.", 10, 500, 0.875)):
        f = font(size, weight)
        tw = d.textlength(text, font=f)
        d.text(((panel - tw) / 2, h * y), text, font=f, fill=(255, 255, 255))
    d.rectangle((panel, 0, panel + SCALE - 1, h), fill=(232, 196, 178))
    return img.resize((493, 312), Image.LANCZOS)


def banner():
    # Inner dialogs: WiX prints the title/description in black on the left, so keep that area light.
    w, h = 493 * SCALE, 58 * SCALE
    img = Image.new("RGB", (w, h), CREAM)
    strip = 96 * SCALE
    g = gradient(strip, h).convert("RGBA")
    mask = Image.linear_gradient("L").rotate(90).resize((strip, h))  # fade the orange in from the left
    img.paste(g, (w - strip, 0), mask)
    ic = icon(42 * SCALE)
    img.paste(ic, (w - ic.width - 10 * SCALE, (h - ic.height) // 2), ic)
    ImageDraw.Draw(img).rectangle((0, h - 2 * SCALE, w, h), fill=BOTTOM)
    return img.resize((493, 58), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
dialog().save(OUT / "dialog.bmp")
banner().save(OUT / "banner.bmp")
print("wrote", OUT / "dialog.bmp", OUT / "banner.bmp")
