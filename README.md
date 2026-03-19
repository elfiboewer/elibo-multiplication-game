# EliBo Multiplication Game

Kinderfreundliches Einmaleins-Spiel auf Basis von **Angular 21** + **PrimeNG**.

## Feature-Umfang

- Zufällige Multiplikationsaufgaben (kleines Einmaleins)
- Konfigurierbarer Zahlenraum (`2-20`) und Rundenzahl (`3-20`)
- Direktes Feedback pro Antwort (richtig/falsch/fehlende Eingabe)
- Fortschrittsanzeige, Punktestand, aktuelle Serie und beste Serie
- Abschlussansicht mit Trefferquote und Neustart-Funktion

## Lokal starten

```bash
npm install
npm start
```

App läuft dann unter `http://localhost:4200/`.

## Build

```bash
npm run build
```

## Tests

```bash
npm test -- --watch=false
```

Abgedeckte Kernfälle:

1. **Happy Path:** korrekte Antwort erhöht Punktestand und wechselt in die nächste Runde.
2. **Edge Case:** fehlende Eingabe zeigt Warnung und lässt die Runde unverändert.
3. Spielende nach letzter Runde wird korrekt erkannt.

## Deployment (CI/CD -> GHCR -> Portainer)

Der Standard-Deploy ist vorbereitet:

- Push auf `main`/`master` startet `.github/workflows/elibo-multiplication-game-ci-cd.yml`
- Build + Tests + Docker Push nach GHCR
- Automatischer Deploy nach Portainer (wenn DEV-Secrets gesetzt sind)
- Deployment-Verifikation über Portainer-Container-Health (Pflicht) + optionalen externen Healthcheck (`ELIBO_MULTIPLICATION_GAME_HEALTHCHECK_URL`)
- Manueller Deploy (`elibo-multiplication-game-manual-deploy`) bricht mit klarer Fehlermeldung ab, wenn die Portainer-Secrets fehlen

Relevante Dateien:

- `Dockerfile`
- `nginx.conf`
- `docker-compose.stack.yml`
- `DEPLOYMENT_AUTOMATION_SETUP.md`

Default-Port-Mapping im Stack: **Host `8090` -> Container `80`**.
