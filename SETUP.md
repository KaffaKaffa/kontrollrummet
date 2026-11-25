# Sätt upp Kontrollrummet

Instruktioner till Claude Code, som en person har bett att sätta upp Kontrollrummet på sin dator. Gå igenom stegen i ordning. Ta reda på själv det som går (operativsystem, vad som är installerat och inloggat), och fråga bara det du inte kan veta: var repot ska ligga om standardplatsen inte passar, vad personen heter om `gh` inte vet, vilket repo som ska bli första projektet. Säg kort vad du gör i varje steg, och sammanfatta på slutet vad som är klart och vad personen själv behöver göra.

Allt körs på personens egen dator och under hens egna konton. Installera inget utan att säga vad det är, och skriv aldrig in lösenord eller tokens själv: inloggningar gör personen i ett terminalfönster du öppnar.

## 1. Datorn

Ta reda på om det är macOS eller Windows, och kontrollera:

| | macOS | Windows 10/11 |
|---|---|---|
| Node 22.18 eller nyare (`node --version`) | `brew install node` | `winget install --id OpenJS.NodeJS.LTS --exact` |
| Git | Xcode Command Line Tools: `xcode-select --install` | `winget install --id Git.Git --exact` |
| Swift-kompilatorn (för appen) | ingår i Command Line Tools | behövs inte |
| `gh`, GitHubs CLI | `brew install gh` | `winget install --id GitHub.cli --exact` |
| Claude Code, inloggat med en prenumeration (`claude auth status`) | finns, du kör ju i det | samma |

Saknas något: säg vad och installera det. `gh` behöver vara inloggat (`gh auth status`); är det inte det, öppna ett terminalfönster åt personen med `gh auth login` (macOS: `osascript -e 'tell application "Terminal" to do script "gh auth login"'`, Windows: `wt powershell -NoExit -Command gh auth login`) och vänta tills hen säger att det är klart.

Node måste vara minst 22.18: servern kör TypeScript direkt och använder `node:sqlite`.

## 2. Repot

Klona till `~/Dev/kontrollrummet` om personen inte vill ha det någon annanstans:

```
git clone https://github.com/KaffaKaffa/kontrollrummet.git ~/Dev/kontrollrummet
cd ~/Dev/kontrollrummet
npm install
```

## 3. Den här datorns inställningar

`~/.control-room/env` (macOS: `export NAMN="värde"`, Windows: `NAMN=värde`, en per rad) läses av servern och allt den startar. Skriv bara det som behövs:

- **Claude-profil:** kör Claude Code med en annan profil än standard (`CLAUDE_CONFIG_DIR` är satt i den här sessionen)? Skriv `CLAUDE_CONFIG_DIR` med samma värde, och `GH_CONFIG_DIR` om profilen har en egen `gh`-mapp (`<profil>/gh`). Annars behövs inget.
- **Namn:** agenterna kallar personen vid förnamn, och tar det från `gh` (`gh api user --jq .name`). Saknas namnet där, fråga, och skriv `CONTROL_ROOM_OWNER`.

Har personen fler Claude-profiler (`~/.claude-*`), hittar Kontrollrummet dem själv vid första starten. Varje projekt kan sedan köra på sitt eget konto.

## 4. Installera

macOS:
```
npm run install:mac
```
Det bygger Kontrollrummet.app i `~/Applications`, och en LaunchAgent startar servern och skrivborden vid inloggning.

Windows (PowerShell):
```
npm run install:windows
```
Det bygger `Kontrollrummet.exe` i `%LOCALAPPDATA%\Kontrollrummet` och lägger det i Autostart, Start-menyn och på skrivbordet.

API-nycklar till OpenAI och Google Gemini är valfria (porträtt, loggor och konsulter). De läggs enklast in i appen efteråt, under Inställningar → Konsulter → API-nycklar: knappen öppnar sidan där nyckeln skapas och ett terminalfönster där personen klistrar in den, och den sparas i nyckelringen (macOS) eller krypterad för användaren (Windows). Det går också att sätta `OPENAI_API_KEY` i miljön för installationskommandot. Skriv aldrig en nyckel i en fil.

Kontrollera sedan att servern svarar: `http://127.0.0.1:4317/` ska ge 200 inom en halv minut.

## 5. Skrivborden i Claude-appen

Skrivborden (Teamleader, Arkitekt, Gudfadern) är Remote Control-sessioner som personen når från Claude-appen i telefonen. Claude Code frågar en gång per mapp och profil om mappen är betrodd och om Remote Control ska slås på, och de frågorna kräver ett tangentbord. Öppna ett terminalfönster åt personen i `desks/teamleader` med `claude remote-control`, be hen svara ja på frågorna och sedan avsluta med Ctrl+C. Samma i `desks/architect` och `desks/gudfadern`. Skrivborden startar sedan av sig själva inom en halv minut. Loggarna finns i `~/.control-room/logs/desk-*.log`.

## 6. Första projektet

Fråga vilket repo (en mapp på datorn) som ska bli första projektet. Läs in det och skapa projektet med serverns API, så som guiden i appen gör:

```
curl -s -X POST http://127.0.0.1:4317/api/projects/scan -H 'content-type: application/json' -d '{"path":"<mappen>"}'
```

Svaret har `name`, och förslag på agenter och skills i `suggested`. Visa personen förslaget i en mening (vilka agenter), och skapa sedan projektet:

```
curl -s -X POST http://127.0.0.1:4317/api/projects -H 'content-type: application/json' -d '{
  "name": "<namn>",
  "source": { "kind": "existing", "path": "<mappen>" },
  "account": "<konto-id ur ~/.control-room/accounts.json, standard om bara ett>",
  "roles": <suggested.roles>,
  "skills": <suggested.skills som [{ "id": "<id>", "mode": "local" }, …]>,
  "prompt": "",
  "onboarding": true
}'
```

Är mappen flera repon (svaret har `repos`), lägg till `"repos": [<id för de repon som hör till projektet>]`.

Kontrollrummet identifierar sedan själv var projektet körs (moln, konton, felkällor) från repot och de inloggade CLI:erna, och ett första onboarding-kort låter teamet läsa in sig. Vill personen hellre göra det själv: guiden finns under **+** i appen.

Vill personen köra Claude via Microsoft Foundry i stället för en prenumeration: se [`docs/foundry.md`](docs/foundry.md).

## 7. Klart

Öppna appen (macOS: `open ~/Applications/Kontrollrummet.app`, Windows: Kontrollrummet i Start-menyn), och säg:

- att uppgifter lämnas till teamleadern i rutan uppe till vänster, och att allt som kräver ett beslut hamnar i Inkorgen,
- att klockan uppe till höger slår på systemnotiser,
- vad som eventuellt återstår (inloggningar, skrivbord som väntar på svar i ett terminalfönster),
- att `README.md` beskriver resten.
