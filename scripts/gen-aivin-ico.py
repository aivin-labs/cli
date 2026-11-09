"""Tạo bin/lib/remote/desktop/aivinIco.mjs: .ico nhiều cỡ (16…256) cho Aivin.exe / khay / cửa sổ.

Nguồn: logo 512×512 nền trắng của FE (`fe/public/icons/v2/icon-512x512.png`) → tách nền trắng thành trong suốt (color-to-alpha),
thu nhỏ Lanczos từng cỡ. Cỡ < 256 ghi dạng BMP 32-bit (System.Drawing.Icon trên .NET Framework đọc được), 256 ghi PNG.
Chạy: python scripts/gen-aivin-ico.py ../fe/public/icons/v2/icon-512x512.png
"""
import base64, io, struct, sys
from pathlib import Path
from PIL import Image

SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
OUT = Path(__file__).resolve().parent.parent / 'bin' / 'lib' / 'remote' / 'desktop' / 'aivinIco.mjs'


def white_to_alpha(im):
    """GIMP color-to-alpha với nền trắng: giữ nguyên màu đã trộn lên nền trắng, viền khử răng cưa không còn quầng trắng."""
    im = im.convert('RGBA')
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            alpha = max(255 - r, 255 - g, 255 - b) / 255.0
            if alpha <= 0:
                px[x, y] = (0, 0, 0, 0)
                continue
            un = lambda c: max(0, min(255, round((c - 255 * (1 - alpha)) / alpha)))
            px[x, y] = (un(r), un(g), un(b), round(alpha * a))
    return im


def crop_to_content(im, pad_ratio=0.04):
    box = im.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    side = max(box[2] - box[0], box[3] - box[1])
    side = int(side * (1 + 2 * pad_ratio))
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(im, (round(side / 2 - cx), round(side / 2 - cy)))
    return canvas


def bmp_entry(img):
    w, h = img.size
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    rows = []
    for y in range(h - 1, -1, -1):
        rows.append(b''.join(struct.pack('BBBB', *(lambda p: (p[2], p[1], p[0], p[3]))(img.getpixel((x, y)))) for x in range(w)))
    mask_row = ((w + 31) // 32) * 4
    return header + b''.join(rows) + b'\0' * (mask_row * h)


def build_ico(master):
    entries = []
    for s in SIZES:
        img = master.resize((s, s), Image.LANCZOS)
        if s >= 256:
            buf = io.BytesIO(); img.save(buf, 'PNG', optimize=True); data = buf.getvalue()
        else:
            data = bmp_entry(img)
        entries.append((s, data))
    out = struct.pack('<HHH', 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    for s, data in entries:
        out += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return out + b''.join(d for _, d in entries)


def main():
    src = Image.open(sys.argv[1])
    master = crop_to_content(white_to_alpha(src))
    if len(sys.argv) > 2:
        master.resize((256, 256), Image.LANCZOS).save(sys.argv[2])
    ico = build_ico(master)
    b64 = base64.b64encode(ico).decode()
    lines = ',\n'.join(f"  '{b64[i:i + 150]}'" for i in range(0, len(b64), 150))
    OUT.write_text(
        '// Tạo bởi scripts/gen-aivin-ico.py — không sửa tay.\n'
        f'/** Biểu tượng Aivin.exe dạng .ico nhiều cỡ ({", ".join(map(str, SIZES))} px): Windows chọn đúng cỡ theo DPI thay vì phóng / thu một ảnh 64×64 (bị nhoè trên taskbar). */\n'
        f'export const AIVIN_ICO_BASE64 = [\n{lines},\n].join(\'\');\n',
        encoding='utf-8', newline='\n')
    print(OUT, len(ico), 'bytes')


main()
