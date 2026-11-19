#!/bin/zsh
# Started by Kontrollrummet.app in background mode (the LaunchAgent se.kontrollrummet). Keeps the Mac awake while it runs.
set -eu
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# launchd starts with no locale; CocoaPods and other Ruby tools fail without UTF-8.
export LANG="${LANG:-en_US.UTF-8}" LC_ALL="${LC_ALL:-en_US.UTF-8}"
# This Mac's own settings, such as a Claude profile (CLAUDE_CONFIG_DIR) or
# gh config (GH_CONFIG_DIR). Everything the server starts inherits them.
[ -f "$HOME/.control-room/env" ] && source "$HOME/.control-room/env"
cd "${0:A:h}/.."
# The OpenAI key lives in the login keychain, not in a file or the plist.
if key=$(security find-generic-password -s control-room-openai -w 2>/dev/null); then
  export OPENAI_API_KEY="$key"
fi
# Build the web app when it is missing or anything in web/ is newer than the build,
# so a restart always shows what is in the source.
if [ ! -f web/dist/index.html ] || [ -n "$(find web -path web/dist -prune -o -newer web/dist/index.html -type f -print -quit)" ]; then
  npm run build
fi
# Kontrollrummet.app is rebuilt when its Swift source is newer than the installed
# app, and opened again if it was open, so a restart brings that change too.
app="$HOME/Applications/Kontrollrummet.app"
if [ -x "$app/Contents/MacOS/Kontrollrummet" ] && [ -n "$(find mac -name '*.swift' -newer "$app/Contents/MacOS/Kontrollrummet" -print -quit)" ]; then
  # The window, not the background mode that runs this script (its command line goes on with --supervise).
  was_open=$(pgrep -f "$app/Contents/MacOS/Kontrollrummet$" >/dev/null && echo 1 || true)
  if mac/build.sh "$HOME/Applications" >/dev/null; then
    echo "Kontrollrummet.app ombyggd."
    if [ -n "$was_open" ]; then
      osascript -e 'quit app "Kontrollrummet"' || true
      # Opened once the server answers, so the app does not show its waiting page for long.
      ( sleep 4; open "$app" ) &
    fi
  fi
fi
exec caffeinate -i node --disable-warning=ExperimentalWarning server/main.ts
