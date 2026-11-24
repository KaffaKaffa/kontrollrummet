# Plan: agenter som inte ger upp när något kräver behörighet

Status: plan, ingen kod.

## Bakgrund

Agenterna säger ofta att något "inte går": tester i webbläsaren, bygga och köra en backend i worktreen, nå en lokal databas. Samma sak fungerar när ägaren kör `claude` i terminalen. Ofta hinner ägaren inte svara på en fråga innan agenten har hoppat över testet och öppnat en PR. Ägaren vill att agenterna löser problemen själva, och att det hen alltid vill tillåta kan sparas med "Tillåt alltid".

### Det som finns i dag

- Agenter startas med `claude -p --permission-mode auto` (`server/agent.ts`, `startAgent`), med `--permission-prompt-tool mcp__control-room__approve`, `--allowedTools mcp__control-room` plus kortets egna tillstånd (`allowedFor`) och `--disallowedTools` med `NEVER` (`server/claude-run.ts`). Planerare får dessutom `HANDS_OFF` (Edit, Write, NotebookEdit, Task).
- PR #7 lade till tillstånd per kort (`server/grants.ts`, `~/.control-room/grants.json`). När auto-läget eller en spärr säger nej läggs nejet fram i "Kräver beslut" (`reportDenial` i `server/mcp.ts`). Svarar ägaren "Tillåt och kör om" sparas kommandot på kortet, och agenten startas igen. Tillståndet gäller bara det kortet och bara det exakta kommandot.
- Frågor via `approve` väntar i 30 minuter och blir sedan ett nej. Vid nej svarar `approve`: "Fortsätt utan det, eller fråga varför i ditt slutmeddelande."
- `shared.md` säger: "Nekas ett kommando hamnar det hos ägaren med en knapp, och tills dess fortsätter du med det som går."

### Vad som faktiskt stoppas (data, 16–24 november)

Från `events` i `state.db` (cirka 200 kort) och kontonas `settings.json`:

**Ingen sandbox och inga allow-regler.** Kontona har inga `permissions` och ingen `sandbox` i sin `settings.json`. Alla `Operation not permitted` i loggarna kommer från macOS (TCC på Group Containers, `kill` i en emulator), inte från Claude Code. Skillnaden mot terminalen ligger alltså inte i settings. Den ligger i tre saker:

1. I terminalen ser ägaren nejet direkt och skriver "kör". Auto-klassaren läser användarens meddelanden och släpper igenom det nästa gång. I `-p` når klassarens nej aldrig `--permission-prompt-tool`. Agenten får bara texten "continue working on other tasks" och gör det.
2. `reportDenial` lägger fram nejet men håller inte kvar agenten. Den avslutar turen, rapporterar och öppnar en PR. Säger ägaren ja senare startas en ny tur.
3. Texterna (`shared.md`, `approve`) säger åt agenten att fortsätta utan.

**Auto-klassarens nej, 22 st:**

| Skäl | Antal | Kommandon |
|---|---|---|
| Destructive or Unwanted Actions | 14 | `git reset --hard FETCH_HEAD/origin/<egen gren>` i egen worktree (5), `kill`/`pkill` av egen dev-server (3), `git push --force-with-lease` på egen gren, `git commit` i egen worktree (2), `rm -rf ~/Library/Developer/Xcode/DerivedData/*`, en skill, `release_resource` |
| Unauthorized Access | 5 | läsa lokal connection string (`dotnet user-secrets list`), grep efter lösenord i ett lokalt startskript, läsa en App Store-nyckel, `sdkmanager --licenses` |
| Undermining Oversight | 3 | arkitekten skriver en planfil med `cat > … <<EOF` (2, eftersom Edit/Write är spärrade; hände igen när den här planen skrevs), skapa en brandväggsregel i molnet |

**Spärrar ur NEVER, 13 st:** alla var läsningar av release- eller uppladdningsskript (`sed`, `grep`, `node --check`, `git checkout` på filen). De rättades i PR #7 (`runs()` matchar bara körning).

**Frågor via `approve`, 14 st:** 6 var konsultfrågor (avsiktliga). Resten var `rm node_modules` (en symlänk agenten själv lagt i worktreen) och `pkill` av egna dev-servrar. En fråga gick ut efter 30 minuter och blev nej.

**Annat som fick agenter att ge upp:**

- Playwright-MCP:n får bara skriva inom worktreen. Skärmdumpar och uppladdningar i `/tmp` nekades ("outside allowed roots").
- En backend startade inte via `use_app` eftersom en Docker-container inte gick att starta. Agenten rapporterade i stället för att starta Docker.
- Testare som fann simulatorn låst av ett annat kort rapporterade `needs-you` direkt (4 kort) i stället för att vänta på låset.
- Saknad Chromium för Playwright löste agenten själv. Så ska det se ut.

Slutsats: nästan allt som stoppas är rutin i agentens egen worktree (återställa grenen, stoppa egna processer, städa byggutdata, läsa lokala dev-hemligheter). Det går att tillåta i förväg och säga till klassaren i ägarens ord. Det som återstår måste hålla kvar kortet tills ägaren svarat.

## Förslag

Fyra delar som hänger ihop:

1. **Stående tillstånd per roll** för rutin i egen worktree, skickade som allow-regler och sagda i ägarens ord i första meddelandet, så att klassaren vet att det är tillåtet.
2. **"Tillåt alltid"** sparar en regel per projekt (eller globalt), lokalt i `~/.control-room/`, som skickas med `--allowedTools` till alla kort i projektet. Reglerna syns och kan tas bort under Inställningar → Behörigheter.
3. **Ett nej eller en väntande fråga håller kvar kortet.** Medan en fråga är öppen kan kortet inte rapporteras `done` eller `pr-open`. Det står som "Väntar på dig" tills ägaren svarat, och agenten startas igen när svaret kommer. Ingen tidsgräns på 30 minuter som blir ett nej.
4. **Nya texter** som säger: lös miljön själv, vänta på svar, försök en annan väg vid nej, och öppna aldrig en PR med ett test du hoppat över utan att säga det.

NEVER rörs inte. Deny går alltid före allow i Claude Code, så inga nya allow-regler kan släppa igenom en release, en deploy eller en merge.

### Regelns form

Samma syntax som Claude Code: `Bash(<prefix>:*)` för kommandon och `mcp__<server>__<verktyg>` för verktyg. Ett förslag tas fram ur kommandot som nekades (`suggestRules` i `server/grants.ts`):

- Dela på `&&`, `||`, `;`, `|` och radbrytning, som `neverRulesHit` redan gör. Ta bort `cd …` och `VAR=… ` i början. En regel per del som inte redan är tillåten.
- Ta kommandot och dess underkommando, plus de flaggor som avgör vad det gör: `npx playwright test e2e/x.spec.ts` → `Bash(npx playwright test:*)`, `git reset -q --hard FETCH_HEAD` → `Bash(git reset --hard:*)`, `dotnet user-secrets list` → `Bash(dotnet user-secrets list:*)`.
- Ägaren kan ändra förslaget innan det sparas (bredare eller smalare).
- Servern vägrar regler som blir för breda, både förslag och ägarens egna: `Bash`, `Bash(*)`, ett ensamt skal eller tolk (`bash`, `sh`, `zsh`, `node`, `python*`, `ruby`, `pwsh`, `eval`, `exec`, `sudo`, `xargs`), `rm -rf:*` utan sökväg, `curl … | sh` och allt som en NEVER-regel träffar (`neverRulesHit`). Sådant går bara att tillåta på kortet, som i dag.
- Auto-läget ignorerar själv breda regler som ger godtycklig körning. Spärren ovan gör att ägaren ser det direkt i stället för att regeln tyst inte verkar.

### Var reglerna sparas

`~/.control-room/permissions.json` (`DATA_DIR`), utanför git och utanför repona:

```json
{
  "global": [{ "rule": "Bash(npx playwright test:*)", "roles": null, "at": "…", "from": { "team": "…", "card": 123, "command": "…" } }],
  "teams": { "<team-id>": [{ "rule": "Bash(dotnet user-secrets list:*)", "roles": ["fullstack", "tester"], "at": "…", "from": {} }] }
}
```

`roles: null` betyder alla roller som får ändra kod. Planerare (`PLANNERS`) får bara regler som uttryckligen nämner deras roll, så att en regel för utvecklarna inte ger arkitekten Bash-skrivning.

Varför inte projektets `.claude/settings.local.json`: den delas med ägarens egna terminalsessioner i repot och syns inte i kontrollrummet. Varför inte `--settings`: `--allowedTools` används redan för kortets tillstånd, och samma väg för allt gör det enkelt att se vad ett kort fick (loggas vid start).

### Standardregler per roll

I `server/permissions.ts` (ny), som kod och inte inställning, så att de följer med uppdateringar. De gäller bara roller som får ändra kod (inte `PLANNERS`). Cwd är kortets egen worktree, och varje kort har sin egen gren, så `reset --hard` och `clean` rör bara det egna kortets arbete.

| Grupp | Regler |
|---|---|
| Git i egen worktree | `Bash(git reset --hard:*)`, `Bash(git clean -fd:*)`, `Bash(git push --force-with-lease origin HEAD:*)`, `Bash(git commit:*)`, `Bash(git stash:*)` |
| Beroenden och bygge | `Bash(npm install:*)`, `Bash(npm ci:*)`, `Bash(npm run:*)`, `Bash(npx tsc:*)`, `Bash(pnpm install:*)`, `Bash(pnpm run:*)`, `Bash(yarn install:*)`, `Bash(pod install:*)`, `Bash(dotnet restore:*)`, `Bash(dotnet build:*)`, `Bash(dotnet run:*)`, `Bash(xcodebuild:*)`, `Bash(./gradlew:*)` |
| Tester | `Bash(npm test:*)`, `Bash(npx vitest:*)`, `Bash(npx jest:*)`, `Bash(npx playwright:*)`, `Bash(dotnet test:*)`, `Bash(swift test:*)`, `Bash(swift build:*)` |
| Lokala tjänster | `Bash(docker compose up:*)`, `Bash(docker compose start:*)`, `Bash(docker start:*)`, `Bash(open -a Docker:*)`, `Bash(xcrun simctl:*)`, `Bash(emulator:*)`, `Bash(adb:*)` |
| Lokala dev-hemligheter | `Bash(dotnet user-secrets list:*)` (se Beslut 1) |
| Städning av byggutdata | `Bash(rm -rf ~/Library/Developer/Xcode/DerivedData:*)` |

`npm run:*` och liknande är säkra tack vare NEVER: `npm run release:ios` träffar fortfarande `Bash(npm *release:*)`, och deny vinner.

`kill`/`pkill` tillåts inte. Agenten ska använda `free_port`, som redan stoppar processer i egen worktree (`server/strays.ts`). Texterna säger det tydligare (T2).

## Steg per roll

Ordning: S1 först (avgör hur resten byggs), sedan S2–S9 och U1–U3 parallellt med T1–T5. Allt görs av **fullstack** i en PR, eller i två (server+UI, texter). **Testaren** verifierar efteråt.

### Serverändringar

**S1. Kontrollera hur auto-läget behandlar allow-regler i `-p`** (en timme, före allt annat). Starta en egen server (`CONTROL_ROOM_PORT=4399 CONTROL_ROOM_DATA=$(mktemp -d)`) och ett kort i ett testrepo. Kontrollera:

- att `--allowedTools 'Bash(git reset --hard:*)'` gör att `git reset --hard origin/main` går utan klassaren,
- att `Bash(npm run:*)` tillsammans med NEVER fortfarande stoppar `npm run release:x`,
- att en mening i ägarens ord i första användarmeddelandet ("du får … i din worktree") räcker för att klassaren släpper igenom `kill` av en egen process. Det är samma knep som `allowAndRerun` redan använder.

Skriv ner resultatet i PR:en. Om allow-regler inte går före klassaren bärs del 1 av texten i första meddelandet (S3), och reglerna blir ändå kvar för det som går.

**S2. `server/permissions.ts` (ny):** standardregler per roll (tabellen ovan), `load/save` av `permissions.json`, `rulesFor(team, role)` och `isTooBroad(rule)`. Exportera `addRule`, `removeRule` och `listRules(team)`.

**S3. `server/agent.ts`, `startAgent`:**

- `--allowedTools 'mcp__control-room', ...rulesFor(team, role), ...allowedFor(subtask.id)`.
- Logga en systemrad vid start, bara när reglerna ändrats sedan förra starten: "Tillåtet utöver auto: N regler (M från projektet)".
- Lägg ett stycke i ägarens ord först i första meddelandet till ett nytt kort (inte vid `--resume`): "Det här får du göra i din egen worktree utan att fråga: …", byggt av samma regler i klartext. `handoff()` tar med stycket.

**S4. `server/grants.ts`:** `suggestRules(command): string[]` (formen ovan). `addGrant` får `scope: 'card' | 'team' | 'global'`. `card` blir som i dag. De andra skriver via `permissions.ts` och startar om kortet med samma meddelande som `allowAndRerun`.

**S5. `server/mcp.ts`, frågor som håller kvar kortet:**

- Ta bort `APPROVAL_TIMEOUT` som ett nej. En fråga ligger kvar tills ägaren svarat eller kortet stoppas. Agentprocessen väntar som mest `CONTROL_ROOM_TOOL_MS` (35 min); därefter svarar `approve` `deny` med "Ingen har svarat än. Avsluta turen med report status waiting-approval; du startas igen med svaret." Frågan ligger kvar i inkorgen, och ett ja startar kortet igen (som `allowAndRerun`). En process som väntar i timmar skulle hålla låsta resurser och ett öppet sessionsfönster.
- `approve` vid nej: "{ägaren} sa nej till just det här{: skäl}. Försök en annan väg till samma mål. Finns ingen, rapportera needs-you med frågan. Öppna inte en PR som om det var gjort."
- `report`: ny status `waiting-approval` (visas "Väntar på dig"). Rapporterar agenten `done` eller `pr-open` medan kortet har en öppen fråga eller ett öppet nej, svarar verktyget med ett fel: "Du har en fråga hos {ägaren} (…). Rapportera waiting-approval, eller säg i skipped vad som hoppades över och varför." Nytt fält `skipped: string[]` (det som inte gjordes) låter agenten komma förbi; det syns på kortet.
- `reportDenial`: kortet går till `waiting-approval` när turen slutar, om nejet fortfarande är öppet. Ja → `allowAndRerun` (finns). "Låt bli" → kortet startas med "{ägaren} vill inte att du kör det{: skäl}. Försök en annan väg, eller avsluta med needs-you."
- `decideApproval` tar emot `{ allow, scope?, rules?, reason? }` från UI:t.

**S6. `server/main.ts`:**

- `POST /api/approvals/:id` tar `scope`, `rules` (redigerade regler) och `reason`.
- `GET /api/permissions?team=` (standard + projekt + globala, med ursprung), `POST /api/permissions` (lägg till, validerad med `isTooBroad`), `DELETE /api/permissions` (`{ scope, team?, rule }`). Board-svaret får `suggestedRules` per fråga.

**S7. `server/worktree.ts`:** lägg `node_modules` (utan snedstreck, så att även en symlänk matchar) i `.git/info/exclude` med `setExcluded` när en worktree skapas. Då behöver agenten aldrig `rm node_modules` före en commit. Det var den vanligaste frågan via `approve`.

**S8. Playwright-MCP:n:** när servern startas för ett kort (`server/mcp-servers.ts`), sätt dess output-katalog till en katalog i worktreen (t.ex. `.cr-out/`, i `info/exclude`) eller lägg till kortets temp-katalog bland tillåtna rötter. Skärmdumpar och testfiler hamnar då där agenten får skriva.

**S9. Arkitekter som ska lägga planen i en PR:** `save_plan` får en valfri `file` (sökväg under `docs/plans/`). Servern skriver filen i kortets worktree. Då behöver arkitekten inte gå runt Edit/Write-spärren med `cat > … <<EOF`, vilket klassaren läser som att gå runt tillsynen. Commit och push gör arkitekten med Bash som i dag.

### UI-ändringar

**U1. `web/src/ui.tsx`, `ApprovalCard`:** tre knappar i stället för två.

- **Godkänn** / **Tillåt och kör om**: bara den här gången (eller kortet, för ett nej, som i dag).
- **Tillåt alltid…**: fäller ut förslagen från `suggestedRules`, en rad per regel, redigerbar, med kryssruta. Under: "Gäller [projektet ▾ | alla projekt]" och "för [alla roller som ändrar kod ▾ | bara <roll>]". Spara skickar `scope` och `rules`. En regel som `isTooBroad` stoppar visas med skälet och kan inte sparas.
- **Neka** / **Låt bli**: med ett valfritt fält "varför" som går till agenten.
- Visa hur länge frågan har väntat. Ta bort "inom 30 minuter".

**U2. `web/src/project.tsx`, ny flik `permissions: 'Behörigheter'` i `TAB_LABEL`:**

- Tre listor: *Alltid tillåtet i projektet*, *Alltid tillåtet i alla projekt*, och *Standard för roller som ändrar kod* (bara läsbar, med en mening om varför).
- Varje rad: regeln i `code`, roller, när och från vilket kort (länk), och en knapp **Ta bort**.
- Ett fält för att lägga till en regel för hand, med samma validering.
- Längst ner, bara läsbart: *Aldrig tillåtet* (NEVER), så att ägaren ser gränsen.

**U3. Kortet och boarden:** status `waiting-approval` får samma plats som `needs-you` i inkorgen ("Kräver beslut") och en egen etikett "Väntar på dig" i `web/src/ui.tsx`. Ett kort som rapporterats med `skipped` visar raden "Hoppade över: …" i kortvyn. `web/src/api.ts` får typerna `PermissionRule` och den nya statusen.

### Textändringar

**T1. `shared.md`, "När du behöver ägaren":** ersätt meningen "Nekas ett kommando … fortsätter du med det som går" med:

> Nekas något, eller väntar du på ett godkännande, är kortet inte klart. Gör klart det som inte beror på det, och avsluta sedan med `report` status `waiting-approval`. Du startas igen när svaret kommer. Säger ägaren nej: försök en annan väg till samma mål. Finns ingen, rapportera `needs-you` med frågan. Öppna aldrig en PR som om ett test var gjort när det inte var det. Står något som inte kunde göras, skriv det i `skipped`.

**T2. `shared.md`, ny rubrik "Lös det själv först":** en checklista före varje `needs-you` eller `failed` som gäller miljön:

> 1. Läs felet. Saknas ett program, en webbläsare, en runtime eller ett paket: installera det (`npm install`, `npx playwright install chromium`, `pod install`, `brew install …`).
> 2. Startar inte en tjänst: starta det den behöver (Docker med `open -a Docker`, sedan `docker compose up -d`). Läs loggen som `use_app` pekar på.
> 3. Upptagen port: `free_port`, eller välj en ledig port. Stoppa aldrig processer med `kill`.
> 4. Låst resurs: vänta och försök igen med `acquire_resource` några gånger under turen innan du rapporterar. Väntar du bara på ett lås, rapportera `waiting-approval` hellre än `needs-you`.
> 5. Skärmdumpar och testfiler skrivs i worktreen, inte i `/tmp`.
> 6. Först när du provat det här och det kräver ägaren (inloggning, konto, betalning, beslut): `needs-you`, med vad du provat.

**T3. `server/mcp.ts`, texterna i `approve`, `report` och `free_port`** enligt S5. `report` beskriver `waiting-approval` och `skipped`.

**T4. `desks/teamleader/CLAUDE.md`:** ett kort i `waiting-approval` är inte klart och inte fast. Teamleadern skapar inga nya kort för det och väntar på ägaren. Ett barnkort som rapporterats med `skipped` ska följas upp (testkort) innan uppgiften räknas som klar.

**T5. `desks/architect/CLAUDE.md`:** planfiler skrivs med `save_plan` och `file` (S9), aldrig med heredoc i Bash.

## Filer och befintlig kod som återanvänds

- `server/grants.ts`: `neverRulesHit` (delning per del) blir grunden för `suggestRules`. `addGrant`/`allowedFor` ligger kvar för kortnivån.
- `server/agent.ts`: `allowAndRerun` (omstart med meddelande i ägarens ord), `denialReason`, argumentlistan i `startAgent`, `handoff`, `PLANNERS`, `finish`.
- `server/mcp.ts`: `requestApproval`, `decideApproval`, `reportDenial`, `approve`, `report`, `free_port`, `save_plan`.
- `server/strays.ts`: `freePort` (stoppar redan egna processer rätt).
- `server/worktree.ts`: `setExcluded`.
- `server/claude-run.ts`: `NEVER`, `CONTROL_ROOM_TOOL_MS`.
- `server/main.ts`: `/api/approvals/:id`, board-svaret.
- `web/src/ui.tsx`: `ApprovalCard`, statusetiketter. `web/src/project.tsx`: `ProjectSettings`, `TAB_LABEL`. `web/src/api.ts`.
- Ny fil: `server/permissions.ts`.
- Texter: `shared.md`, `desks/teamleader/CLAUDE.md`, `desks/architect/CLAUDE.md`.

## Beslut som behövs (med rekommendation)

1. **Får roller som ändrar kod läsa lokala dev-hemligheter** (`dotnet user-secrets list`, `.env` i worktreen) utan att fråga? Rekommendation: ja, bara lokala. Det krävs för att köra en backend mot en lokal databas, och klassaren stoppade det varje gång. Molnhemligheter (`az keyvault`, nycklar i hemkatalogen) frågar fortfarande.
2. **Var hamnar "Tillåt alltid" som förval:** projektet eller alla projekt? Rekommendation: projektet. Globalt väljs aktivt.
3. **Hur länge en agentprocess väntar på svar:** rekommendation som i S5. Processen avslutas efter 35 minuter, kortet står i `waiting-approval` och startas igen med svaret. Ingen tidsgräns som blir ett nej.

## Risker

- **För breda regler.** `npm run:*` och `./gradlew:*` kör vad som helst som repot definierar. Det skyddas av att NEVER vinner över allow, att cwd är egen worktree och att `isTooBroad` stoppar de breda formerna. Det är samma förtroende som när ägaren kör `npm run` i terminalen.
- **`git push --force-with-lease origin HEAD`** kan skriva över en gren som en annan agent pushat till. `--force-with-lease` skyddar om agenten har hämtat. Main skyddas av grenregler på GitHub, inte av oss.
- **Klassaren kan ändras.** Det som bärs av text i ägarens ord kan sluta fungera i en ny version av Claude Code. S1 dokumenterar läget, och reglerna i `--allowedTools` är det som håller.
- **Kort som väntar i timmar** håller sin worktree. Låsen släpps redan när turen slutar (`releaseLocks` i `finish`), så det gäller bara disken.
- **`waiting-approval` som ny status** måste in överallt där statusar räknas (inkorg, 3D-kontoret, notiser, teamleaderns väckning). Gå igenom med `grep -rn "needs-you" server web/src`.

## Verifiering

Med en egen server (`CONTROL_ROOM_PORT=4399 CONTROL_ROOM_DATA=$(mktemp -d)`) och ett testrepo:

1. Ett kort som kör `git reset --hard origin/main`, `npm install`, `npx playwright test` och `docker compose up -d` i sin worktree går utan någon fråga.
2. `npm run release:x` nekas fortfarande, även med `Bash(npm run:*)` sparad.
3. Ett kommando utanför reglerna nekas. Kortet hamnar i `waiting-approval` och öppnar ingen PR. "Tillåt alltid" med ett redigerat förslag sparar regeln i `permissions.json`, kortet startas om och kommandot går. Ett nytt kort i samma projekt kör det direkt, ett kort i ett annat projekt gör det inte.
4. Regeln syns under Inställningar → Behörigheter. **Ta bort** tar bort den, och nästa kort frågar igen.
5. `Bash(*)`, `Bash(node:*)` och en regel som träffar NEVER kan inte sparas, varken från frågan eller från fliken.
6. En fråga som ingen svarar på i en timme blir inte ett nej. Kortet står kvar och går vidare när ägaren svarar.
7. "Låt bli" med ett skäl: agenten försöker en annan väg eller rapporterar `needs-you`, inte `pr-open`.
8. `report` med `pr-open` medan en fråga är öppen avvisas med felet från S5.
9. Arkitekten kan lägga en plan i `docs/plans/` med `save_plan` och `file` utan nej.
10. `npm run typecheck`, `npm run build` och `npm run check:public` går igenom.
