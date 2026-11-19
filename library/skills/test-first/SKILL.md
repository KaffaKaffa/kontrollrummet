---
name: test-first
description: Rätta en bugg genom att först skriva ett test som återskapar den. Använd när ett kort beskriver ett fel som går att reproducera i kod.
---
# Test först

1. Hitta var felet sitter och var närliggande tester finns. Följ projektets testmönster.
2. Skriv det minsta test som återskapar felet. Kör det och se att det **misslyckas av rätt anledning**.
3. Rätta felet med minsta möjliga ändring.
4. Kör testet igen, och sedan hela testsviten för den del du rört.
5. I PR-beskrivningen: vad felet var, varför det uppstod och hur testet visar att det är rättat.

Går felet inte att återskapa i ett test (UI-timing, plattformsspecifikt): säg varför, och beskriv hur testaren ska verifiera det.
