# Projekten

Varje projekt är en mapp här, `teams/<id>/`, och skapas med guiden i appen (**+** i toppraden). Projekten är din dators egna och checkas aldrig in: `.gitignore` utesluter allt här utom den här filen och mallen.

En projektmapp innehåller:

- `team.json`: namn, basbranch, människorna i projektet, releaser, Figma-synk. Delas av alla som kör samma projekt.
- `team.local.json`: den här datorns sökvägar, Claude-konto, az-profil, infrastruktur och felbevakning, VM:ar. Formen syns i [`team.local.example.json`](team.local.example.json); det mesta fylls i av appen (Inställningar → Infrastruktur → Identifiera).
- `roles/*.md`: agenterna, gjorda från mallarna i `library/roles/`.
- `notes/*.md`: det varje roll lärt sig, skrivet av agenterna själva.
- `shared.md`: det alla agenter i projektet ska veta.

Porträtten hamnar i `web/public/avatars/<projekt>-<roll>.png` och checkas inte heller in.
