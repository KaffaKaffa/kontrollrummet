# Projekten

Varje projekt är en mapp här, `teams/<id>/`, och skapas med guiden i appen (**+** i toppraden). Projekten är din dators egna och checkas aldrig in: `.gitignore` utesluter allt här utom den här filen och mallen.

En projektmapp innehåller:

- `team.json`: namn, basbranch, människorna i projektet, releaser, Figma-synk. Delas av alla som kör samma projekt.
- `team.local.json`: den här datorns sökvägar, Claude-konto, az-profil, infrastruktur och felbevakning, VM:ar. Formen syns i [`team.local.example.json`](team.local.example.json); det mesta fylls i av appen (Inställningar → Infrastruktur → Identifiera).
- `roles/*.md`: agenterna, gjorda från mallarna i `library/roles/`.
- `notes/*.md`: det varje roll lärt sig, skrivet av agenterna själva.
- `shared.md`: det alla agenter i projektet ska veta.
- `run/*`: skript som startar appen så som projektets folk gör det, t.ex. `run/portal.sh serve`. En apps kommando kan peka på ett (`"$CR_RUN/portal.sh" serve`); agenterna rättar skripten när något inte stämmer. Utan appar hamnar kommentaren överst i varje skript i agenternas prompt under **Starta appen**.

## Appar lokalt

`devApps` i `team.local.json` är projektets utvecklingsmiljöer: det man kör på datorn när man utvecklar. Listan görs av en agent som läser repona när projektet läggs till, och rättas under Inställningar → Appar. Varje app får en knapp i toppraden med ett fönster där den startas och stoppas och där utskriften syns.

```json
"devApps": [{ "id": "web", "label": "Webben", "repo": "web", "dir": "apps/web", "command": "pnpm run dev", "url": "http://localhost:5173", "ports": [5173], "notes": "Logga in som test@example.com", "keepRunning": false }]
```

Kontrollrummet kör kommandot med zsh i `dir`, med `CR_ROOT` (checkouten), `CR_CARD` (kortet, tomt för ägaren) och `CR_RUN` (`run/`-mappen). Processen loggar till `~/.control-room/devapps/` och lever vidare när servern startas om. Agenterna startar aldrig en egen kopia: de använder appen med `use_app` och säger `done_with_app`. Ett kort får appen startad från sin worktree om ingen använder den, delar den med kort på samma PR och står annars i kö. När sista agenten är klar får ägaren välja om appen ska stängas ner eller fortsätta, utom när `keepRunning` är satt. Medan ägaren tittar på appen (kryssrutan i fönstret, eller när ägaren startat den) får agenterna använda den som den är men inte stoppa eller flytta den.

I `team.json` kan också `color` (teamets färg i kontoret) och `resources` stå: sådant i projektet som bara ett kort åt gången kan använda, som en backend på en fast port som inloggningen kräver.

```json
"resources": { "portal": { "label": "Portal lokalt (https://localhost:2222)", "ports": [2222, 2221] } }
```

En agent tar resursen med `acquire_resource` och anger vilken PR den kör. Ett kort på samma PR delar instansen, och ett kort på en annan PR ställer sig i kö: det förbereder sig under tiden, väcks när resursen släpps och får portarna frigjorda.

Porträtten hamnar i `web/public/avatars/<projekt>-<roll>.png` och checkas inte heller in.
