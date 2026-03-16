# Deployment Automation Setup (elibo-multiplication-game)

Dieses Repo ist für den Standard-Flow **GitHub -> GHCR -> Portainer** vorbereitet.

## Enthalten

- CI/CD Workflow: `.github/workflows/elibo-multiplication-game-ci-cd.yml`
- Manueller Deploy Workflow: `.github/workflows/elibo-multiplication-game-manual-deploy.yml`
- Docker Image Build: `Dockerfile` (Angular Build -> Nginx Runtime)
- Portainer Stack Definition: `docker-compose.stack.yml`
- Helper Scripts:
  - `scripts/ensure-portainer-stack.mjs`
  - `scripts/portainer-stack.mjs`
  - `scripts/wait-health.mjs`

## Benötigte GitHub Secrets

### Pflicht (DEV)

- `PORTAINER_DEV_URL` *(oder `PORTAINER_URL`)*
- `PORTAINER_DEV_API_KEY` *(oder `PORTAINER_API_KEY`)*
- `PORTAINER_DEV_ENDPOINT_ID` *(oder `PORTAINER_ENDPOINT_ID`)*

### Optional

- `ELIBO_MULTIPLICATION_GAME_EXTERNAL_PORT` (Default: `8090`)
- `ELIBO_MULTIPLICATION_GAME_HEALTHCHECK_URL`

## Laufzeit-Defaults

- Stack Name: `elibo-multiplication-game`
- Container Name: `elibo-multiplication-game`
- Image: `ghcr.io/<owner>/elibo-multiplication-game:main`
- Host-Port: `8090` -> Container-Port `80`
- Health Endpoint (Container intern): `/health`

## Trigger

- **Auto Deploy:** Push auf `main`/`master`
- **Manuell:** GitHub Actions -> `elibo-multiplication-game-manual-deploy`

## Lokale Checks vor Push

```bash
npm ci
npm run test -- --watch=false
npm run build
```
