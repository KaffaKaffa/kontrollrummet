---
name: safe-upgrade
description: Uppgradera ett beroende utan överraskningar. Använd när ett kort gäller att uppgradera ett paket, ett ramverk eller ett verktyg.
---
# Säker uppgradering

1. Läs ändringsloggen mellan nuvarande och nya versionen. Notera brytande ändringar och borttagna API:er.
2. Välj en version som har funnits ute i minst två veckor, om kortet inte säger annat.
3. Uppgradera ett beroende (eller en tätt sammanhörande grupp) per PR. Uppdatera låsfilen med projektets verktyg.
4. Sök efter användning av de API:er som ändrats och anpassa koden.
5. Kör bygg, typkontroll och tester. Starta appen om ändringen kan märkas i körning.
6. I PR-beskrivningen: från och till vilken version, brytande ändringar och vad du anpassade.
