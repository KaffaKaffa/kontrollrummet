// Masks a square PNG into the macOS app icon shape: a rounded square with the
// standard margin, so the icon sits next to other apps in the Dock.
// swift mac/round-icon.swift in.png out.png
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let source = NSImage(contentsOfFile: args[1]) else {
    FileHandle.standardError.write("usage: round-icon in.png out.png\n".data(using: .utf8)!)
    exit(1)
}

let size = 1024.0
let inset = 100.0 // Apple's grid: an 824 pt body on a 1024 canvas.
let body = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let radius = body.width * 0.225

let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSBezierPath(roundedRect: body, xRadius: radius, yRadius: radius).addClip()
source.draw(in: body, from: .zero, operation: .copy, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
