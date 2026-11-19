#!/bin/zsh
# Started by Kontrollrummet.app in background mode (services.json): a
# Remote Control server in desks/<role>, so the session shows up in the Claude
# app. With an account (from ~/.control-room/accounts.json), the desk runs on
# that Claude profile; Gudfadern has one desk per account.
set -eu
role="$1"
account="${2:-}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# launchd starts with no locale; CocoaPods and other Ruby tools fail without UTF-8.
export LANG="${LANG:-en_US.UTF-8}" LC_ALL="${LC_ALL:-en_US.UTF-8}"
# This Mac's own settings, such as a Claude profile (CLAUDE_CONFIG_DIR) or
# gh config (GH_CONFIG_DIR). Everything the server starts inherits them.
[ -f "$HOME/.control-room/env" ] && source "$HOME/.control-room/env"
root="${0:A:h}/.."
if [ -n "$account" ]; then
  # The account's profile, as the server would set it: the standard one runs without CLAUDE_CONFIG_DIR.
  eval "$(cd "$root" && node --disable-warning=ExperimentalWarning --input-type=module -e "
    const a = await import('./server/accounts.ts');
    const env = a.accountEnv(process.argv[1], {});
    const q = (s) => \"'\" + s.replaceAll(\"'\", \"'\\\\''\") + \"'\";
    console.log('unset CLAUDE_CONFIG_DIR GH_CONFIG_DIR');
    for (const k of ['CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR']) if (env[k]) console.log('export ' + k + '=' + q(env[k]));
    console.log('account_name=' + q(a.getAccount(process.argv[1]).name));
  " "$account")"
fi
token_file="$HOME/.control-room/desk-token"
# The server writes the token on its first start.
for i in {1..60}; do [ -f "$token_file" ] && break; sleep 2; done
export CONTROL_ROOM_DESK_TOKEN="$(cat "$token_file")"
# plan_feature waits for the architect; the tool call must outlive that.
export MCP_TOOL_TIMEOUT=1800000
case "$role" in
  teamleader) name="Kontrollrummet · Teamleader" ;;
  architect) name="Kontrollrummet · Arkitekt" ;;
  gudfadern) name="Kontrollrummet · Gudfadern${account:+ ($account_name)}" ;;
  *) name="Kontrollrummet · $role" ;;
esac
cd "$root/desks/$role"
exec claude remote-control --name "$name" --permission-mode auto
