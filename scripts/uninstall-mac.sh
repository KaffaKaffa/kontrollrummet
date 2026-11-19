#!/bin/zsh
# Stops and removes what install-mac.sh set up. State in ~/.control-room stays.
set -u
agents="$HOME/Library/LaunchAgents"
# The one LaunchAgent, and any from before it (one per service).
for plist in "$agents"/se.kontrollrummet.plist "$agents"/se.kontrollrummet.server.plist "$agents"/se.kontrollrummet.desk.*.plist(N); do
  [ -f "$plist" ] || continue
  label="$(basename "$plist" .plist)"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
  rm -f "$plist"
done
rm -f "$HOME/.control-room/services.json"
rm -rf "$HOME/Applications/Kontrollrummet.app"
echo "Borttaget. Data och loggar finns kvar i ~/.control-room."
