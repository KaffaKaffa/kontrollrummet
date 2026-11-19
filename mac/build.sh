#!/bin/zsh
# Builds Kontrollrummet.app into ~/Applications. Run by scripts/install-mac.sh.
set -eu
root="${0:A:h}/.."
out="${1:-$HOME/Applications}/Kontrollrummet.app"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
swiftc -O -o "$out/Contents/MacOS/Kontrollrummet" "$root/mac/Kontrollrummet.swift" -framework Cocoa -framework WebKit -framework UserNotifications
# The name LaunchAgents from before the single one start (install-mac.sh replaces them).
cp "$out/Contents/MacOS/Kontrollrummet" "$out/Contents/MacOS/kontrollrummet-launch"

# The icon: the PWA artwork masked to the macOS shape, at every size iconutil wants.
swift "$root/mac/round-icon.swift" "$root/web/public/icons/icon-1024.png" "$work/icon.png"
set_dir="$work/AppIcon.iconset"
mkdir -p "$set_dir"
for s in 16 32 128 256 512; do
  sips -z $s $s "$work/icon.png" --out "$set_dir/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$work/icon.png" --out "$set_dir/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o "$out/Contents/Resources/AppIcon.icns"

cat > "$out/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Kontrollrummet</string>
  <key>CFBundleDisplayName</key><string>Kontrollrummet</string>
  <key>CFBundleIdentifier</key><string>se.kontrollrummet.app</string>
  <key>CFBundleExecutable</key><string>Kontrollrummet</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.3</string>
  <key>CFBundleVersion</key><string>$(date +%Y%m%d%H%M)</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

# Ad hoc: it only ever runs on this Mac.
codesign --force --sign - "$out" >/dev/null
echo "$out"
