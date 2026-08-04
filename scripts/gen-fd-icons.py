#!/usr/bin/env python3
"""產生定期存款追蹤器嘅 PWA 圖標（純 Python，無需外部套件）。
設計：圓角方形深綠底 + 三條白色上升柱狀圖（代表資產增長）。
輸出 192 / 512 一般圖標，同一個 512 maskable（四邊留安全邊距）。"""
import struct, zlib, os

OUT = os.path.join(os.path.dirname(__file__), "..", "fd", "icons")

# 主題色（深青綠）
BG_TOP = (13, 94, 82)      # #0d5e52
BG_BOT = (16, 122, 106)    # #107a6a
BAR = (255, 255, 255)

def rounded_rect_mask(w, h, r):
    """回傳一個判斷 (x,y) 是否喺圓角方形內嘅函數。"""
    def inside(x, y):
        # 四個角
        cx = min(max(x, r), w - 1 - r)
        cy = min(max(y, r), h - 1 - r)
        dx = x - cx
        dy = y - cy
        return dx * dx + dy * dy <= r * r
    return inside

def build(size, pad_ratio=0.0, corner_ratio=0.22):
    """回傳 RGBA bytes。pad_ratio 為 maskable 安全邊距（背景鋪滿，圖案內縮）。"""
    px = bytearray()
    r = int(size * corner_ratio)
    inside = rounded_rect_mask(size, size, r)

    # 圖案（柱狀圖）繪製區域，內縮 pad
    inset = int(size * (0.20 + pad_ratio))
    plot_l = inset
    plot_r = size - inset
    plot_b = size - inset
    plot_t = inset
    plot_w = plot_r - plot_l
    # 三條柱，高度遞增
    n = 3
    gap = int(plot_w * 0.10)
    bar_w = (plot_w - gap * (n - 1)) // n
    heights = [0.45, 0.70, 1.0]  # 相對於繪圖區高度
    plot_h = plot_b - plot_t
    bars = []
    for i in range(n):
        bl = plot_l + i * (bar_w + gap)
        br = bl + bar_w
        bt = plot_b - int(plot_h * heights[i])
        bars.append((bl, br, bt, plot_b))

    for y in range(size):
        # 垂直漸變
        t = y / (size - 1)
        bg = (
            round(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t),
            round(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t),
            round(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t),
        )
        px.append(0)  # PNG filter type 0
        for x in range(size):
            if not inside(x, y):
                px.extend((0, 0, 0, 0))  # 透明角
                continue
            # 檢查是否喺柱內
            ink = False
            for (bl, br, bt, bb) in bars:
                if bl <= x < br and bt <= y < bb:
                    ink = True
                    break
            if ink:
                px.extend((BAR[0], BAR[1], BAR[2], 255))
            else:
                px.extend((bg[0], bg[1], bg[2], 255))
    return bytes(px)

def write_png(path, size, raw):
    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8bit RGBA
    idat = zlib.compress(raw, 9)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))

os.makedirs(OUT, exist_ok=True)
for size in (192, 512):
    write_png(os.path.join(OUT, f"icon-{size}.png"), size, build(size))
# maskable：留多啲安全邊距
write_png(os.path.join(OUT, "icon-maskable-512.png"), 512, build(512, pad_ratio=0.08))
print("icons written to", os.path.abspath(OUT))
