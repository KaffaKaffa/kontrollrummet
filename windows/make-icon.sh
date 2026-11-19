#!/bin/zsh
# Builds windows/Kontrollrummet.ico from the PWA artwork, on a Mac (swift, sips).
# The .ico is committed, so Windows needs no image tools: run this again only
# when web/public/icons/icon-1024.png changes.
set -eu
root="${0:A:h}/.."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# Windows icons fill more of their square than macOS's: a small margin, softer corners.
cat > "$work/round.swift" <<'SWIFT'
import AppKit
let a = CommandLine.arguments
let source = NSImage(contentsOfFile: a[1])!
let size = 1024.0, inset = 40.0
let body = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8,
  samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSBezierPath(roundedRect: body, xRadius: body.width * 0.18, yRadius: body.width * 0.18).addClip()
source.draw(in: body, from: .zero, operation: .copy, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
SWIFT
swift "$work/round.swift" "$root/web/public/icons/icon-1024.png" "$work/icon.png"
for s in 16 24 32 48 64 128 256; do sips -z $s $s "$work/icon.png" --out "$work/$s.png" >/dev/null; done
# An .ico is a directory of PNGs: a 6-byte header, a 16-byte entry per image, then the images.
node -e '
const fs = require("fs");
const [dir, out] = process.argv.slice(1);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => fs.readFileSync(`${dir}/${s}.png`));
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s === 256 ? 0 : s, 0); e.writeUInt8(s === 256 ? 0 : s, 1);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});
fs.writeFileSync(out, Buffer.concat([head, ...entries, ...pngs]));
' "$work" "$root/windows/Kontrollrummet.ico"
# The page's own icon too, for the app window's taskbar button and the tab.
cp "$work/32.png" "$root/web/public/icons/favicon-32.png"
echo "windows/Kontrollrummet.ico"
