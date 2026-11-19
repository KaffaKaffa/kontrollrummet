---
name: a11y-check
description: Tillgänglighetsgenomgång av UI du byggt eller ändrat. Använd innan PR för ändringar i skärmar, formulär, dialoger och komponenter.
---
# Tillgänglighet

Gå igenom det du ändrat:
- **Tangentbord:** allt går att nå och använda med Tab/Enter/Escape, fokus syns, fokus fångas i dialoger och återställs när de stängs.
- **Skärmläsare:** knappar och länkar har begripliga namn, bilder har alt-text (tom för dekor), formulärfält har etiketter, felmeddelanden kopplas till fälten.
- **Kontrast:** text minst 4.5:1, stora rubriker och ikoner minst 3:1, i både ljust och mörkt läge.
- **Storlek:** tryckytor minst 44×44 pt på mobil; text går att förstora till 200 % utan att något klipps.
- **Rörelse:** respektera "minska rörelse".
- **Semantik:** rätt element (button, nav, h1–h3 i ordning) före ARIA.

Rätta det du hittar. Det du inte kan rätta inom kortet nämner du i slutmeddelandet.
