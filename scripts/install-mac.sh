#!/bin/zsh
# One-time setup on this Mac: the server and the two desks as LaunchAgents
# (start at login, restart on a crash) and Kontrollrummet.app in ~/Applications.
# Run again after pulling changes to the Swift app; it is safe to repeat.
set -eu
root="${0:A:h:h}"
agents="$HOME/Library/LaunchAgents"
logs="$HOME/.control-room/logs"
mkdir -p "$agents" "$logs"
cd "$root"

echo "› npm install och bygge av webben"
npm install --no-audit --no-fund >/dev/null
npm run build >/dev/null

# The OpenAI key goes to the login keychain once, from the shell that has it.
if ! security find-generic-password -s control-room-openai >/dev/null 2>&1; then
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    security add-generic-password -s control-room-openai -a "$USER" -w "$OPENAI_API_KEY"
    echo "› OpenAI-nyckeln sparad i nyckelringen (control-room-openai)"
  else
    echo "› Ingen OPENAI_API_KEY i miljön: bildgenerering är av tills nyckeln finns i nyckelringen."
  fi
fi

write_agent() {
  local label="$1"; shift
  local log="$1"; shift
  {
    cat <<HEAD
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
HEAD
    for arg in "$@"; do echo "    <string>$arg</string>"; done
    cat <<TAIL
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$logs/$log.log</string>
  <key>StandardErrorPath</key><string>$logs/$log.log</string>
</dict>
</plist>
TAIL
  } > "$agents/$label.plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  # bootout returns before the service is gone; bootstrapping too early fails with "5: Input/output error".
  for i in {1..20}; do launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || break; sleep 0.5; done
  local tries=0
  until launchctl bootstrap "gui/$(id -u)" "$agents/$label.plist" 2>/dev/null; do
    tries=$((tries + 1))
    if [ $tries -ge 5 ]; then launchctl bootstrap "gui/$(id -u)" "$agents/$label.plist"; fi
    sleep 1
  done
  echo "› $label"
}

# The app first: its own binary, in background mode, runs the server and the desks,
# so Login Items shows one Kontrollrummet, and macOS asks for access on its behalf (not node's).
echo "› Kontrollrummet.app"
"$root/mac/build.sh" "$HOME/Applications" >/dev/null

# What it runs: the server, the teamleader's and architect's desks, and Gudfadern's
# desk per Claude account (a Remote Control session belongs to one login).
node --disable-warning=ExperimentalWarning --input-type=module -e "
  const a = await import('./server/accounts.ts');
  const [root, logs, out] = process.argv.slice(1);
  const desk = (name, ...args) => ({ name, log: logs + '/' + name + '.log', command: ['/bin/zsh', root + '/scripts/run-desk.sh', ...args] });
  const services = [
    { name: 'server', log: logs + '/server.log', command: ['/bin/zsh', root + '/scripts/run-server.sh'] },
    desk('desk-teamleader', 'teamleader'),
    desk('desk-architect', 'architect'),
    ...a.listAccounts().map((x) => desk('desk-gudfadern-' + x.id, 'gudfadern', x.id)),
  ];
  (await import('node:fs')).writeFileSync(out, JSON.stringify(services, null, 2) + '\\n');
" "$root" "$logs" "$HOME/.control-room/services.json"
echo "› Tjänster: $HOME/.control-room/services.json"

# The LaunchAgents from before (one per service) go: the one below runs them all.
for old in "$agents"/se.kontrollrummet.server.plist "$agents"/se.kontrollrummet.desk.*.plist; do
  [ -f "$old" ] || continue
  label="$(basename "$old" .plist)"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$old"
done

echo "› LaunchAgent"
write_agent se.kontrollrummet supervisor "$HOME/Applications/Kontrollrummet.app/Contents/MacOS/Kontrollrummet" --supervise "$HOME/.control-room/services.json"

echo "  $HOME/Applications/Kontrollrummet.app – dra den till Docken."

echo
echo "Loggar: $logs"
echo "Skrivborden i Claude-appen kräver att mappen är betrodd: kör claude (med samma profil som i ~/.control-room/env) en gång i $root/desks/teamleader och godkänn."
echo "Gudfadern har ett skrivbord per konto: kör claude en gång i $root/desks/gudfadern med varje kontos profil (CLAUDE_CONFIG_DIR=…) och godkänn."
