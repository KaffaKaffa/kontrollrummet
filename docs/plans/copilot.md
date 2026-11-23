# Plan: GitHub Copilot-licens i Kontrollrummet

Status: plan, ingen kod. Källorna kontrollerade mot GitHubs dokumentation 2026-11-23 (länkar sist).

## Bakgrund

- Varje agent startas som en `claude -p`-process (`server/agent.ts`, `CLAUDE_BIN` i `server/config.ts`), med stream-json, `--resume`, `--mcp-config` till kontrollrummets MCP och rättigheter via `--permission-prompt-tool mcp__control-room__approve` och `--disallowedTools` (`server/claude-run.ts`). Kostnad läses från `total_cost_usd`, kvot från `rate_limit_event`.
- **Konsulter finns redan** (`server/consultants.ts`, mallar i `library/consultants/`, UI i `web/src/consultants.tsx`):
  - En konsult är en fil `teams/<team>/consultants/<id>.md` med front matter (`kind: text|image`, `provider`, `model`, `mcp`, `askers`, `consent: always|session|never`, …) och instruktioner.
  - `SERVICES` listar leverantörerna, var och en `via: 'api'` (servern frågar själv: OpenAI, Gemini, Grok, Perplexity) eller `via: 'mcp'` (agenten får MCP-servern).
  - Nycklar: `KEY_SERVICE` (miljövariabel + nyckelringstjänst `control-room-<provider>`), klistras in i ett terminalfönster från Inställningar → Konsulter → API-nycklar, aldrig i en fil.
  - `listModels(provider)` hämtar modellerna från leverantörens eget API, `defaultModel` väljer en rimlig.
  - Verktyget `consult` i `server/mcp.ts` kontrollerar `askers`, ber ägaren om lov enligt `consent`, visar fråga och svar på kortet som `system`-händelser och anropar `consult()`.
  - Konsulten ser bara frågan: inte repot, inte kortet.
- **Copilot faktureras inte längre per premium request.** Sedan 1 juni 2026 betalar man per token och modell i *AI Credits* (1 credit = 0,01 USD). Pro har 1 500 credits i månaden, Pro+ 7 000, Max 20 000, Business 1 900 per användare, Enterprise 3 900. Premium requests med multiplikatorer finns bara kvar för Pro och Pro+ på äldre årsplaner. Planen räknar i credits men hanterar båda.

## Förslag

Copilot blir **en leverantör till i konsultsystemet**, inte ett eget verktyg. En konsult med `provider: copilot` och `model: <id ur Copilots lista>` svarar i text via ägarens Copilot-licens. Så återanvänds `consult`, `askers`, `consent`, instruktionerna, porträtten och UI:t, och agenterna lär sig inget nytt verktyg. Med en licens kan teamet ha flera konsulter (en granskare på en Anthropic-modell, en "andra åsikt" på en OpenAI-modell, en billig Gemini för snabba frågor).

### Steg 1: Copilot som konsultleverantör

**Väg:** GitHubs officiella `@github/copilot-sdk` för Node, som styr den officiella Copilot CLI:n över JSON-RPC. Versionerna låses i `package.json` (SDK:n kräver matchande CLI). SDK:n väljs före `copilot -p` eftersom bara SDK:n har dokumenterade fält för kostnad (`assistant.usage`, `session.usage.getMetrics`), modellista med priser (`listModels()`) och kvot (`account.getQuota`). Reservväg om SDK:n inte går: `copilot -p "<fråga>" --model X -s --no-ask-user --available-tools= --no-auto-update` i en tom katalog, svaret från stdout, kostnaden bara uppskattad.

**I `server/consultants.ts`:**
- `SERVICES`: `{ id: 'copilot', label: 'GitHub Copilot', via: 'api', note: 'Modeller från flera leverantörer via din licens', kinds: ['text'] }`. `copilot` läggs till i `ApiProvider` och `API_PROVIDERS`.
- `KEY_SERVICE.copilot = { env: 'COPILOT_GITHUB_TOKEN', service: 'control-room-copilot' }` och `KEY_PAGE.copilot` till sidan för fine-grained tokens på GitHub.
- `listModels('copilot')` och `defaultModel` anropar `server/copilot.ts` (nedan). Modellistan cachas en timme.
- `consult()` får en gren `c.provider === 'copilot'` → `askCopilot(c, question)` med `c.instructions` som systemprompt. Svar och kostnad går tillbaka som i dag, plus kostnaden (se Kvot).

**Ny fil `server/copilot.ts`:** SDK-klienten. En process startas vid första frågan och hålls vid liv (stängs efter 10 min utan frågor).
- `COPILOT_GITHUB_TOKEN` från `keyOf('copilot')`, `COPILOT_HOME=~/.control-room/copilot` så att ägarens egna `~/.copilot` (sessioner, MCP-servrar, instruktioner) inte följer med.
- `models()`: `listModels()` med id, namn, leverantör och `billing.tokenPrices`.
- `ask({ model, system, question, timeoutMs })`: en ny session per fråga, **utan verktyg och utan MCP-servrar**, med en tom temp-katalog under `~/.control-room/copilot/tmp/<id>` som arbetskatalog. Den tas bort efteråt. Returnerar text, tokens, credits och tid.
- `quota()`: `account.getQuota` (kvar av månaden i procent, när den nollställs, plan).

**Konsulten bara läser.** Tre lager: sessionen har inga verktyg, cwd är en tom katalog, och konsulten ser bara frågan (som alla API-konsulter i dag). Inga filer skickas med i steg 1; agenten klistrar in det som behövs i frågan, som för andra konsulter.

**Modellval och lista:** Inställningar → Konsulter → ny konsult → leverantör GitHub Copilot → modellväljaren fylls från `/api/consultants/models?provider=copilot` (finns redan). Visa pris per miljon tokens in/ut bredvid varje modell, så att ägaren väljer medvetet. `consultantsSection` skriver modell och ungefärligt pris i agentens prompt, så att agenten vet att frågan kostar.

**Inloggning och var den syns:**
- En fine-grained PAT med behörigheten **"Copilot Requests"** (classic `ghp_` stöds inte). Den klistras in som de andra nycklarna under Inställningar → Konsulter → API-nycklar och ligger i nyckelringen (macOS) eller krypterat (Windows).
- På samma ställe visas för Copilot: inloggad som, plan, kvar av månadens credits och när de nollställs (`quota()`), och månadens förbrukning i kontrollrummet.
- Saknas token visas "(nyckel saknas)" i väljaren, som för de andra.

**Tidsgräns:** 180 s per fråga (en konstant, kan bli `timeout` i front matter senare). Vid timeout: `session.abort()`, därefter kill på CLI-processen om den inte svarar. Agenten får "Inget svar inom 180 s från <konsult>; fortsätt utan eller förenkla frågan." Det som redan förbrukats räknas.

**Svar och kostnad på kortet:**
- Fråga och svar visas som i dag (`Frågar …` och `… svarar:`). Svarsraden får ett tillägg: `[<modell> · 1 820 in / 640 ut · 3,1 credits · 14 s]`.
- Ny kolumn `consult_credits` på subtask (migrering som `cost_usd` i `server/db.ts`), som summeras och visas bredvid kostnaden på kortet (`web/src/ui.tsx`), t.ex. "12 cr". Credits blandas inte med `costUsd`: Claude-kostnaden är teoretisk (abonnemang), credits är riktiga pengar.
- Raden i `~/.control-room/consultants.log` får credits som en kolumn till.

### Kvot och kostnad

- **Mätning:** ny tabell `copilot_usage` (tid, team, kort, konsult, modell, in- och ut-tokens, nanoAiu, credits, premium-kostnad). Credits från `session.usage.getMetrics().totalNanoAiu`; är den experimentella metoden borta: tokens från `assistant.usage` × priset från `listModels()`. På äldre planer sparas `totalPremiumRequestCost`.
- **Gränser,** i Inställningar → Konsulter → Copilot, med förslag på standard:
  - per kort: 50 credits (0,50 USD)
  - per dag, alla team: 300 credits
  - spärr när mindre än 10 % av månaden är kvar
- **Före anropet** räknar servern en övre gräns: (tecken i fråga + instruktioner) / 3 × inpris + max ut-tokens × utpris. Får den inte plats i kortets eller dagens rest nekas frågan, och inget skickas.
- **När kvoten tar slut:** `consult` returnerar ett fel: "Copilot-kvoten för kortet/dagen/månaden är slut (x av y credits). Gör utan konsulten, eller rapportera needs-you om svaret behövs." Kortet stoppas inte. Ägaren får en notice (`addNotice`), högst en per dag och gräns. Fel från GitHub om slut kvot eller rate limit behandlas likadant.
- **Hos GitHub:** rekommendera ägaren att sätta budgeten för extra AI credits till 0 USD med "Stop usage when budget limit is reached". Då kan inget gå över planen ens om kontrollrummets räkning blir fel.

### Data och villkor

- **Vad som skickas:** konsultens instruktioner och frågan, till GitHub och vidare till modellens leverantör (OpenAI, Google, Anthropic, xAI …). Varken repot, worktreen, briefen eller samtalet följer med.
- **Lagring:**
  - De arkiverade Copilot Product Specific Terms säger att prompts till verktyg utanför editorn (som CLI:n) sparas "to provide the service".
  - Trust Center anger enligt uppgift att Copilot CLI inte sparas som standard. Uppgifterna går isär.
  - GitHub har zero data retention med Anthropic, men inte för Claude Fable 5.x som standard.
  - Utgå från att frågan kan sparas hos GitHub i upp till 28 dagar.
- **Regler:**
  - Beskrivningen av `consult` och `consultantsSection` får en rad för Copilot-konsulter: "Frågan går till GitHub och modellens leverantör: inga hemligheter, nycklar, `.env`-innehåll, personuppgifter eller kunddata."
  - Servern kör en enkel kontroll av frågan innan något skickas: privata nycklar, `sk-`, `ghp_`, `github_pat_`, `AKIA`, JWT, `password=`. Vid träff nekas frågan med förklaring. Kontrollen läggs i `consult()` och gäller då alla API-konsulter, inte bara Copilot.
  - `consent: session` som standard för Copilot-konsulter, så att ägaren godkänner första frågan per kort.
- **Bara officiella vägar:** SDK:n och CLI:n från GitHub, med ägarens egen token. Inga proxyer (`copilot-api`, `litellm`-adaptrar eller annat som gör om Copilot till ett OpenAI-kompatibelt API), och token används inte direkt mot Copilots interna endpoints. SDK:n finns för program som bygger på Copilot, så ett lokalt verktyg för ens egen räkning ligger inom avsedd användning.
- **Att läsa innan steg 1 slås på:** Product Specific Terms är arkiverade sedan 5 mars 2026 och ersatta av *GitHub Generative AI Services Terms* (gh.io/terms). Den texten och Acceptable Use Policies (särskilt automatiserad bulkaktivitet) är inte lästa än. Är licensen en organisations (Business eller Enterprise) styr organisationens policy vilka modeller som är påslagna och vilken kod som får gå dit.

### Steg 2 (översikt): hela agenter på Copilot CLI

| Behov i dag (claude) | Copilot | Glapp |
|---|---|---|
| stream-json in/ut, en tur per rad | SDK-sessioner med events, och `copilot -p --output-format json` (JSONL) | Liten med SDK:n: ny parser, verktygsvisningen görs om. |
| `--resume <sessionId>` | `--resume`/`--continue`, sessioner i SDK:n | Liten. |
| `--mcp-config` till kontrollrummets MCP | `mcpServers` i `createSession` (stdio och http) | Liten. |
| `--permission-prompt-tool approve`, `--disallowedTools` | Behörighetscallback i SDK:n, `--allow-tool`/`--deny-tool` med mönster (`shell(git:*)`) | Mellan. Spärrlistorna översätts till deny-mönster, godkännandet flyttas till en callback. |
| `total_cost_usd`, `rate_limit_event` | credits per anrop, `account.getQuota` | Mellan. Två sorters kvot, och vilket konto en roll belastar. |
| CLAUDE.md, memory, skills, kompaktering | `AGENTS.md`, egna instruktioner, egna skills | Stor. Promptbygget och memory-sökvägarna antar Claude Code. |
| Konton = Claude-profiler | en Copilot-token per licens | Mellan. Ett konto behöver en typ. |

**Storlek:** ett `AgentRuntime`-gränssnitt (start, skicka tur, events, avbryt, resume, kostnad) med `claude` och `copilot` som implementationer. `agent.ts`, delar av skrivbordens samtal och `claude-run.ts` skrivs om; konton, modellval per roll och kostnadsvyn byggs ut. Grovt **2–4 veckor** för fullstack plus test av varje roll. Största risken är beteende: rollernas prompter är finjusterade för Claude Code.

**Värt det?** Inte nu. Kör steg 1 en månad och titta på vilka konsulter som frågas och vad det kostar. Säger siffrorna att en annan modell gör en roll bättre eller billigare: börja med en läsande roll (arkitekt) på Copilot, som inte behöver skrivflöde eller releasespärrar.

## Steg per roll

| # | Roll | Kort | Beror på |
|---|---|---|---|
| 0 | fullstack (eller juristkonsulten) | Läs GitHub Generative AI Services Terms och AUP; sammanfatta automatisering, lagring och privat respektive organisationslicens i en kommentar på uppgiften. Ingen kod. | – |
| 1 | fullstack | `server/copilot.ts` (SDK med låsta versioner, `COPILOT_HOME`, modellcache, `ask` utan verktyg i tom cwd, timeout och abort, kostnad, `quota`) och `copilot` som leverantör i `consultants.ts` (`SERVICES`, `KEY_SERVICE`, `KEY_PAGE`, `listModels`, `defaultModel`, `askCopilot`). README: Copilot CLI och token som valfritt, som de andra nycklarna. | 0 |
| 2 | fullstack | Kvot och data: tabellen `copilot_usage`, kolumnen `consult_credits`, gränser och förkontroll, hemlighetskontroll i `consult()`, notice när kvoten är slut, raden för Copilot i `consult`-beskrivningen och `consultantsSection`. | 1 |
| 3 | designer | Figma: Copilot-raden under API-nycklar (status, plan, kvar av månaden, gränser), modellväljaren med pris och credits på kortet. | – (parallellt med 1–2) |
| 4 | fullstack | UI efter Figma: `web/src/consultants.tsx`, endpoints i `server/main.ts` (`GET/PUT /api/consultants/copilot` för status och gränser), credits i `web/src/ui.tsx`. | 2, 3 |
| 5 | tester | Egen server (`CONTROL_ROOM_PORT=4399`, tom `CONTROL_ROOM_DATA`). Utan token: "(nyckel saknas)". Med token: skapa två Copilot-konsulter på olika leverantörer, fråga båda, kontrollera credits på kortet och i loggen, tidsgränsen (sänk den), kortgränsen (1 credit), nekad fråga med en falsk nyckel och att worktreen är orörd (`git status`). | 4 |

Steg 2 får egna kort först efter en månad med steg 1 och ett beslut från ägaren.

## Filer och befintlig kod som återanvänds

- `server/consultants.ts`: `SERVICES`, `KEY_SERVICE`/`KEY_PAGE`/`keyOf`, `providerStatus`, `listModels`, `defaultModel`, `consult()`, `consultantsSection`, loggen.
- `server/mcp.ts`: verktyget `consult` (askers, consent, händelser på kortet), `addNotice`.
- `server/secrets.ts`: nyckelring och kryptering på Windows.
- `server/db.ts`: subtask-kolumner och migrering som `cost_usd`.
- `server/usage.ts`: förebild för att spara och visa en kvot.
- `web/src/consultants.tsx`: modellväljaren och API-nycklarna. `web/src/ui.tsx`: kostnaden på kortet.
- `library/consultants/`: en mall för en Copilot-konsult (t.ex. "granskare", andra åsikt på kod och planer) kan läggas till i kort 1.

## Risker

- **SDK:n och CLI:n ändras snabbt,** och vissa RPC:er är experimentella (`session.usage.getMetrics`). Lås versionerna, slå av auto-update, ha reserven tokens × pris.
- **Pengar:** agenter kan fråga ofta eller välja dyra konsulter. Motverkas av gränserna, förkontrollen, `consent`, priset i prompten och budgeten 0 USD hos GitHub.
- **Data:** en agent kan klistra in kunddata eller en hemlighet. Regler och kontroll minskar risken men tar inte bort den. Kod från kundprojekt kan gå till leverantörer som kunden inte godkänt.
- **Licens:** med en organisations licens kan privat användning eller vissa modeller vara otillåtna.
- **Svaret kan vara fel:** ett andra utlåtande är ingen sanning; agenten ansvarar själv för slutsatsen (står redan i `consultantsSection`).
- **Windows:** Copilot CLI och token måste fungera i `windows/`-skalet och med krypterade hemligheter.

## Verifiering

- `npm run typecheck`, `npm run build`, `npm run check:public` per kort.
- En riktig fråga till en billig modell, där credits i `copilot_usage` stämmer med GitHubs användningssida inom ett dygn.
- Testarens punkter i kort 5. Inget i worktreen ändras, kontrollerat med `git status` före och efter.

## Öppna frågor till ägaren

1. **Vilken licens?** Den privata (Pro, Pro+ eller Max) eller en organisations (Business eller Enterprise)? *Rekommendation:* den privata. En organisationslicens kräver att organisationens policy tillåter det och att koden får gå till alla påslagna leverantörer.
2. **Gränser:** 50 credits per kort, 300 per dag och spärr vid 10 % kvar? *Rekommendation:* ja som start, justera efter en månad.
3. **Vilka konsulter från start?** *Rekommendation:* en "granskare" på en stark Anthropic- eller OpenAI-modell för arkitekt och bug, och en billig modell för snabba frågor, båda med `consent: session`.
4. **Kundprojekt:** ska team för kundprojekt få Copilot-konsulter? *Rekommendation:* bara om ägaren lägger till en konsult i det teamet; inga Copilot-konsulter läggs till automatiskt.
5. **Steg 2:** vänta en månad med data innan något byggs? *Rekommendation:* ja.

## Källor

- Copilot CLI programmatic reference: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference
- Köra Copilot CLI programmatiskt: https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically
- CLI command reference (auth, `COPILOT_GITHUB_TOKEN`, "Copilot Requests"-PAT, `COPILOT_HOME`): https://docs.github.com/en/copilot/reference/cli-command-reference
- Copilot SDK, usage and billing: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing
- Copilot SDK, MCP-servrar: https://docs.github.com/en/copilot/how-tos/copilot-sdk/use-copilot-sdk/mcp-servers
- Usage-based billing för individer: https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing
- Modeller och priser: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
- Budgetar: https://docs.github.com/en/copilot/concepts/billing/budgets-for-usage-based-billing
- Ändringen 1 juni 2026: https://github.blog/changelog/2026-06-01-updates-to-github-copilot-billing-and-plans/
- Premium requests (äldre planer): https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/copilot-billing/understanding-and-managing-requests-in-copilot
- Modellhosting och dataskydd: https://docs.github.com/en/copilot/reference/ai-models/model-hosting
- Copilot Product Specific Terms (arkiverade): https://github.com/customer-terms/github-copilot-product-specific-terms
