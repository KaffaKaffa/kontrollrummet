# Säkerhet

Kontrollrummet kör agenter med tillgång till dina repon, dina inloggningar (GitHub, Azure,
molntjänster) och din dator. Ta säkerhetsproblem på allvar och rapportera dem privat.

## Rapportera en sårbarhet

Skriv **inte** ett vanligt issue. Använd GitHubs privata rapportering:
**Security → Report a vulnerability** i det här repot. Beskriv vad som går att göra, hur
man återskapar det och vilken version (commit) det gäller. Du får svar så snart det går.

## Det kontrollrummet aldrig ska göra

- Spara nycklar, tokens eller lösenord i repot eller i klartext på disk. Nycklar ligger i
  macOS nyckelring eller, på Windows, krypterade med DPAPI.
- Lyssna på något annat än den egna datorn: servern binder till `127.0.0.1`, och webbsidan
  och MCP-ändpunkterna kräver rätt värd och ursprung.
- Skicka något till en annan tjänst än den du själv valt för en konsult eller ett projekt.

Hittar du något som bryter mot det är det en sårbarhet.

## Om du själv har läckt något

Har en nyckel hamnat i en commit: byt den hos tjänsten direkt. Att ta bort committen räcker
inte, den finns kvar i forks och cachar.
