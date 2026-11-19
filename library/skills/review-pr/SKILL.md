---
name: review-pr
description: Granska din egen branch innan du öppnar eller uppdaterar en PR. Använd när kortet är klart och innan `gh pr create` eller push av rättelser.
---
# Granska innan PR

1. Ta fram diffen mot basbranchen: `git diff origin/<basbranch>...HEAD --stat`, sedan filerna en i taget.
2. Gå igenom varje ändrad fil mot:
   - repots `CLAUDE.md` och eventuell `REVIEW.md`,
   - kortets brief: gör ändringen det som bads om, och inget mer?
   - fel som syns direkt: null/undefined, felhantering som sväljer fel, race conditions, off-by-one, saknade await.
   - säkerhet: hemligheter i koden, osäker indata till SQL/shell/HTML, behörighet som saknas.
   - prestanda: anrop i loopar, N+1 mot databasen, onödiga omrenderingar.
3. Kör projektets kontroller för det du rört (typkontroll, lint, tester).
4. Rätta det du hittar, committa och kör om steg 3.
5. Rapportera kort i slutmeddelandet vad granskningen hittade och rättade.

Ändra aldrig sådant som inte hör till kortet bara för att du ser det; nämn det i slutmeddelandet i stället.
