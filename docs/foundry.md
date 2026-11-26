# Microsoft Foundry som AI-leverantör

Ett Foundry-konto kör Claude-modeller från en Microsoft Foundry-resurs i stället för en Claude-prenumeration. Det kan ersätta Claude-kontona eller finnas bredvid dem. Du väljer konto per projekt och per Gudfader-samtal, precis som med Claude-konton. Befintliga Claude-konton fungerar som förut.

## Vad du behöver

1. En Foundry-resurs med Claude-modeller deployade.
2. Namnet på resursen (eller hela endpoint-adressen, till exempel `https://min-resurs.services.ai.azure.com`).
3. Namnet på varje deployment du vill använda, för Opus, Sonnet och Haiku. Minst en krävs. Döp helst deploymenten till modellens id, så känner Claude Code igen den.
4. Antingen rollen **Foundry User** på resursen (Entra ID, rekommenderas) eller en API-nyckel.

## Lägg till kontot

1. Öppna **Inställningar → Konton**.
2. Välj **+ Lägg till Foundry-konto** och fyll i namn, resurs, autentisering och deployments.
3. Spara.
   - **Entra ID:** välj **Logga in i Azure**. Ett Terminal-fönster öppnas och kör `az login`. Kontot får en egen az-profil, så det krockar inte med din vanliga inloggning. Ange tenant om du behöver en särskild.
   - **API-nyckel:** Terminal frågar efter nyckeln. Den sparas i nyckelringen (macOS) eller krypterat med DPAPI (Windows), aldrig i en fil och aldrig på kommandoraden.
4. Välj **Testa anslutningen**. Testet kör en kort fråga per nivå och visar resultatet per nivå.

## Tomma nivåer

En nivå utan deployment använder en annan: Haiku använder Sonnet, Sonnet använder Opus och Opus använder Sonnet. Under kontot står vad varje nivå kör just nu.

## Skillnader mot Claude-konton

- Inga gränser för 5 timmar eller vecka visas, och ingen OAuth-status. Det finns inget sådant att visa.
- Utan agenttak kan kostnaden bli hög och resursens tokengräns (TPM) nås. Sätt ett tak under **Konton**.
- Det går inte att ta bort kontot så länge ett projekt eller ett samtal använder det. Byt konto först.
- Att ta bort kontot raderar nyckeln i nyckelringen. Profilmappen under `~/.control-room/profiles` lämnas kvar.

## Felsökning

Testet ger ett tydligt felmeddelande för de vanliga felen:

- **Resursen hittas inte:** kontrollera resursnamnet eller endpoint-adressen.
- **401:** nyckeln är fel eller har gått ut. Välj **Ange nyckel** och skriv in den på nytt.
- **403:** inloggningen saknar rollen Foundry User på resursen.
- **404:** deploymentnamnet finns inte på resursen. Kontrollera stavningen i Foundry.
- **429:** resursens tokengräns är nådd. Vänta, eller höj kvoten i Foundry.
- **Inte inloggad i Azure:** välj **Logga in i Azure**.
