#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';

function usage() {
  console.log(`Usage:
  node scripts/portainer-stack.mjs inspect [--stack-file <path>]
  node scripts/portainer-stack.mjs deploy --image <image-ref> [--stack-file <path>] [--dry-run]
  node scripts/portainer-stack.mjs wait-healthy [--image <image-ref>] [--stack-name <name>] [--timeout <seconds>] [--interval <seconds>]

Environment (required for API calls):
  PORTAINER_URL
  PORTAINER_STACK_ID
  PORTAINER_ENDPOINT_ID
  PORTAINER_API_KEY

Optional:
  PORTAINER_STACK_FILE_PATH
  DEPLOY_IMAGE
  GHCR_REGISTRY_USERNAME
  GHCR_REGISTRY_TOKEN
  GHCR_REGISTRY_NAME (default: ghcr-auto-elibo-multiplication-game)
  HEALTHCHECK_TIMEOUT_SECONDS (default: 300)
  HEALTHCHECK_INTERVAL_SECONDS (default: 8)
`);
}

const IMAGE_ENV_PRIORITY = ['ELIBO_MULTIPLICATION_GAME_IMAGE', 'ELIBO_IMAGE'];

function parseArgs(argv) {
  const out = {
    command: 'inspect',
    image: '',
    stackFile: '',
    stackName: '',
    timeoutSeconds: Number(process.env.HEALTHCHECK_TIMEOUT_SECONDS || 300),
    intervalSeconds: Number(process.env.HEALTHCHECK_INTERVAL_SECONDS || 8),
    dryRun: false,
    help: false
  };

  const tokens = [...argv];
  const maybeCommand = tokens[0];
  if (maybeCommand && !maybeCommand.startsWith('--')) {
    out.command = maybeCommand;
    tokens.shift();
  }

  while (tokens.length) {
    const token = tokens.shift();

    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }

    if (token === '--dry-run') {
      out.dryRun = true;
      continue;
    }

    if (token === '--image') {
      out.image = String(tokens.shift() || '');
      continue;
    }

    if (token === '--stack-file') {
      out.stackFile = String(tokens.shift() || '');
      continue;
    }

    if (token === '--stack-name') {
      out.stackName = String(tokens.shift() || '').trim();
      continue;
    }

    if (token === '--timeout') {
      out.timeoutSeconds = Number(tokens.shift() || out.timeoutSeconds);
      continue;
    }

    if (token === '--interval') {
      out.intervalSeconds = Number(tokens.shift() || out.intervalSeconds);
      continue;
    }

    throw new Error(`Unbekanntes Argument: ${token}`);
  }

  return out;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  }
  return value;
}

function toHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    'X-API-Key': apiKey
  };
}

function formatFetchError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = error.cause;
  if (!cause || typeof cause !== 'object') {
    return error.message;
  }

  const parts = [
    cause.code,
    cause.message,
    cause.errno,
    cause.syscall,
    cause.hostname,
    cause.address,
    cause.port
  ]
    .filter(Boolean)
    .map((value) => String(value));

  return parts.length > 0 ? `${error.message} | cause: ${parts.join(' ')}` : error.message;
}

async function apiJson(baseUrl, path, init, apiKey, timeoutMs = 30000) {
  const url = `${baseUrl}${path}`;

  let res;
  try {
    res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...toHeaders(apiKey),
        ...(init?.headers || {})
      }
    });
  } catch (error) {
    throw new Error(`Netzwerkfehler bei Portainer-Aufruf ${url}: ${formatFetchError(error)}`);
  }

  const bodyText = await res.text();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = bodyText;
  }

  if (!res.ok) {
    throw new Error(
      `Portainer API Fehler ${res.status} (${res.statusText}) auf ${path}: ${
        typeof body === 'string' ? body : JSON.stringify(body)
      }`
    );
  }

  return body;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEnvEntries(entries) {
  const map = new Map();

  for (const entry of entries || []) {
    if (!entry || typeof entry !== 'object') continue;
    const name = entry.name || entry.Name;
    if (!name) continue;

    const value = entry.value ?? entry.Value ?? '';
    map.set(String(name), String(value));
  }

  return map;
}

function envMapToArray(map) {
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, value }));
}

function getImageEnvVarFromStack(stackFileContent, envMap) {
  const stackText = String(stackFileContent || '');

  for (const key of IMAGE_ENV_PRIORITY) {
    if (stackText.includes(`\${${key}}`) || stackText.includes(`$${key}`)) {
      return key;
    }
  }

  for (const key of IMAGE_ENV_PRIORITY) {
    if (envMap.has(key)) {
      return key;
    }
  }

  return '';
}

function getCurrentImageRef(envMap, stackFileContent) {
  for (const key of IMAGE_ENV_PRIORITY) {
    const value = String(envMap.get(key) || '').trim();
    if (value) {
      return value;
    }
  }

  return extractFirstImageRef(stackFileContent) || '';
}

function extractFirstImageRef(composeText) {
  const lines = String(composeText || '').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = line.match(/^\s*image\s*:\s*(.+)\s*$/);
    if (!match) continue;

    const value = match[1].split('#')[0].trim().replace(/^['"]|['"]$/g, '');
    if (value) return value;
  }

  return '';
}

function replaceFirstImageRef(composeText, imageRef) {
  let replaced = false;

  const updated = String(composeText || '')
    .split(/\r?\n/)
    .map((line) => {
      if (replaced) return line;

      const match = line.match(/^(\s*image\s*:\s*)(.+?)(\s*)$/);
      if (!match) return line;

      replaced = true;
      return `${match[1]}${imageRef}${match[3]}`;
    })
    .join('\n');

  return { updated, replaced };
}

function normalizeRegistryUrl(url) {
  return String(url || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

async function ensureGhcrRegistry(config, username, token) {
  const registryName = process.env.GHCR_REGISTRY_NAME || 'ghcr-auto-elibo-multiplication-game';
  const ghcrUrl = 'ghcr.io';

  const payload = {
    Name: registryName,
    URL: ghcrUrl,
    Type: 3,
    Authentication: true,
    Username: username,
    Password: token,
    TLS: true
  };

  const registries = await apiJson(config.baseUrl, '/api/registries', { method: 'GET' }, config.apiKey);

  const byName = (registries || []).find(
    (registry) => String(registry?.Name || '').toLowerCase() === String(registryName).toLowerCase()
  );

  const byUrl = (registries || []).find(
    (registry) => normalizeRegistryUrl(registry?.URL) === normalizeRegistryUrl(ghcrUrl)
  );

  const existing = byName || byUrl;

  if (!existing?.Id) {
    const created = await apiJson(
      config.baseUrl,
      '/api/registries',
      {
        method: 'POST',
        body: JSON.stringify(payload)
      },
      config.apiKey
    );

    console.log(`[info] GHCR registry erstellt (id=${created?.Id || '?'}, name=${registryName}).`);
    return created;
  }

  const updated = await apiJson(
    config.baseUrl,
    `/api/registries/${existing.Id}`,
    {
      method: 'PUT',
      body: JSON.stringify(payload)
    },
    config.apiKey
  );

  console.log(`[info] GHCR registry aktualisiert (id=${existing.Id}, name=${registryName}).`);
  return updated || existing;
}

async function loadStackFile({ baseUrl, stackId, endpointId, apiKey, stackFilePath }) {
  if (stackFilePath) {
    const local = await readFile(stackFilePath, 'utf8');
    return { stackFileContent: local, source: `local:${stackFilePath}` };
  }

  const candidates = [
    `/api/stacks/${stackId}/file?endpointId=${encodeURIComponent(endpointId)}`,
    `/api/stacks/${stackId}/file`
  ];

  let lastError = null;

  for (const path of candidates) {
    try {
      const remote = await apiJson(baseUrl, path, { method: 'GET' }, apiKey);
      const content =
        typeof remote === 'string'
          ? remote
          : String(remote?.StackFileContent || remote?.stackFileContent || '');

      return {
        stackFileContent: content,
        source: `portainer:${path}`
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Konnte Stack-File aus Portainer nicht laden.');
}

async function loadStackMeta({ baseUrl, stackId, endpointId, apiKey }) {
  const candidates = [
    `/api/stacks/${stackId}?endpointId=${encodeURIComponent(endpointId)}`,
    `/api/stacks/${stackId}`
  ];

  let lastError = null;

  for (const path of candidates) {
    try {
      const stack = await apiJson(baseUrl, path, { method: 'GET' }, apiKey);
      return {
        stack,
        envMap: normalizeEnvEntries(stack?.Env || stack?.env || [])
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Konnte Stack-Metadaten aus Portainer nicht laden.');
}

function imageMatches(actualImage, expectedImage) {
  const actual = String(actualImage || '').trim();
  const expected = String(expectedImage || '').trim();

  if (!expected) return true;
  if (!actual) return false;
  if (actual === expected) return true;

  if (actual.startsWith(`${expected}@`)) return true;
  if (expected.startsWith(`${actual}@`)) return true;

  return false;
}

async function listContainersForLabel(config, labelKey, labelValue) {
  const label = `${labelKey}=${labelValue}`;
  const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
  const path = `/api/endpoints/${encodeURIComponent(config.endpointId)}/docker/containers/json?all=1&filters=${filters}`;

  const containers = await apiJson(config.baseUrl, path, { method: 'GET' }, config.apiKey);
  return Array.isArray(containers) ? containers : [];
}

async function listStackContainers(config, stackName) {
  const candidates = [
    ['com.docker.compose.project', stackName],
    ['com.docker.stack.namespace', stackName],
    ['io.portainer.stack.name', stackName]
  ];

  const merged = new Map();

  for (const [labelKey, labelValue] of candidates) {
    const items = await listContainersForLabel(config, labelKey, labelValue);
    for (const container of items) {
      const id = String(container?.Id || container?.ID || '');
      if (!id) continue;
      merged.set(id, container);
    }
  }

  return [...merged.values()];
}

async function inspectContainer(config, containerId) {
  const path = `/api/endpoints/${encodeURIComponent(config.endpointId)}/docker/containers/${encodeURIComponent(containerId)}/json`;
  const details = await apiJson(config.baseUrl, path, { method: 'GET' }, config.apiKey);
  const state = details?.State || {};

  return {
    running: Boolean(state?.Running),
    status: String(state?.Status || ''),
    healthStatus: String(state?.Health?.Status || ''),
    startedAt: String(state?.StartedAt || ''),
    error: String(state?.Error || '')
  };
}

function summarizeContainerStatus(containerStates) {
  return containerStates
    .map((item) => {
      const parts = [`${item.name || item.id}`];
      parts.push(`state=${item.status || (item.running ? 'running' : 'unknown')}`);
      if (item.healthStatus) parts.push(`health=${item.healthStatus}`);
      if (item.expectedImage) {
        parts.push(item.imageMatches ? 'image=ok' : `image=${item.image}`);
      }
      if (item.error) parts.push(`error=${item.error}`);
      return parts.join(' | ');
    })
    .join(' ; ');
}

async function runWaitHealthy(config, options) {
  const timeoutSeconds = Number(options.timeoutSeconds || 300);
  const intervalSeconds = Number(options.intervalSeconds || 8);

  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('Timeout muss > 0 Sekunden sein.');
  }

  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error('Intervall muss > 0 Sekunden sein.');
  }

  const { stack } = await loadStackMeta(config);
  const stackName = String(options.stackName || stack?.Name || stack?.name || '').trim();

  if (!stackName) {
    throw new Error('Konnte keinen Stack-Namen ermitteln (nutze --stack-name).');
  }

  const expectedImage = String(options.image || '').trim();
  const deadline = Date.now() + timeoutSeconds * 1000;
  let attempt = 0;
  let lastSummary = 'no attempts';

  while (Date.now() < deadline) {
    attempt += 1;

    try {
      const containers = await listStackContainers(config, stackName);

      if (!containers.length) {
        lastSummary = `Keine Container für Stack '${stackName}' gefunden`;
        console.log(`⏳ Versuch ${attempt}: ${lastSummary}`);
        await sleep(intervalSeconds * 1000);
        continue;
      }

      const containerStates = [];

      for (const container of containers) {
        const id = String(container?.Id || container?.ID || '');
        const names = Array.isArray(container?.Names) ? container.Names : [];
        const name = String(names[0] || '').replace(/^\//, '');
        const image = String(container?.Image || '').trim();

        let inspect = {
          running: String(container?.State || '') === 'running',
          status: String(container?.State || ''),
          healthStatus: '',
          startedAt: '',
          error: ''
        };

        if (id) {
          try {
            inspect = await inspectContainer(config, id);
          } catch (error) {
            inspect = {
              ...inspect,
              error: `inspect failed: ${error instanceof Error ? error.message : String(error)}`
            };
          }
        }

        const hasHealthcheck = Boolean(inspect.healthStatus);
        const healthy = inspect.running && !inspect.error && (!hasHealthcheck || inspect.healthStatus === 'healthy');
        const imageOk = imageMatches(image, expectedImage);

        containerStates.push({
          id,
          name,
          image,
          expectedImage,
          imageMatches: imageOk,
          running: inspect.running,
          status: inspect.status,
          healthStatus: inspect.healthStatus,
          startedAt: inspect.startedAt,
          error: inspect.error,
          healthy
        });
      }

      const allHealthy = containerStates.every((item) => item.healthy);
      const imagesOk = containerStates.every((item) => item.imageMatches);

      lastSummary = summarizeContainerStatus(containerStates);

      if (allHealthy && imagesOk) {
        const result = {
          stackId: config.stackId,
          endpointId: config.endpointId,
          stackName,
          expectedImage,
          attempts: attempt,
          containers: containerStates.map((item) => ({
            id: item.id,
            name: item.name,
            image: item.image,
            status: item.status,
            healthStatus: item.healthStatus
          }))
        };

        if (process.env.GITHUB_OUTPUT) {
          await BunLikeAppendFile(process.env.GITHUB_OUTPUT, 'runtime_health=healthy\n');
          await BunLikeAppendFile(process.env.GITHUB_OUTPUT, `runtime_container_count=${containerStates.length}\n`);
        }

        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`⏳ Versuch ${attempt}: ${lastSummary}`);
    } catch (error) {
      lastSummary = error instanceof Error ? error.message : String(error);
      console.log(`⏳ Versuch ${attempt}: ${lastSummary}`);
    }

    await sleep(intervalSeconds * 1000);
  }

  if (process.env.GITHUB_OUTPUT) {
    await BunLikeAppendFile(process.env.GITHUB_OUTPUT, 'runtime_health=timeout\n');
  }

  throw new Error(`Container wurden nicht healthy innerhalb von ${timeoutSeconds}s: ${lastSummary}`);
}

async function runInspect(config) {
  const { stackFileContent, source } = await loadStackFile(config);
  const { envMap } = await loadStackMeta(config);

  const imageEnvVar = getImageEnvVarFromStack(stackFileContent, envMap);
  const currentImage = getCurrentImageRef(envMap, stackFileContent);
  const usesEnvImage = Boolean(imageEnvVar);

  const payload = {
    stackId: config.stackId,
    endpointId: config.endpointId,
    source,
    usesEnvImage,
    imageEnvVar,
    currentImage
  };

  if (process.env.GITHUB_OUTPUT) {
    await BunLikeAppendFile(process.env.GITHUB_OUTPUT, `current_image=${currentImage}\n`);
    await BunLikeAppendFile(process.env.GITHUB_OUTPUT, `uses_env_image=${usesEnvImage}\n`);
    await BunLikeAppendFile(process.env.GITHUB_OUTPUT, `image_env_var=${imageEnvVar}\n`);
  }

  console.log(JSON.stringify(payload, null, 2));
}

async function runDeploy(config, imageRef, dryRun) {
  const ghcrUsername = String(process.env.GHCR_REGISTRY_USERNAME || '').trim();
  const ghcrToken = String(process.env.GHCR_REGISTRY_TOKEN || '').trim();

  if (ghcrUsername && ghcrToken) {
    if (dryRun) {
      console.log('[info] Dry-run: GHCR registry bootstrap übersprungen.');
    } else {
      await ensureGhcrRegistry(config, ghcrUsername, ghcrToken);
    }
  }

  const { stackFileContent, source } = await loadStackFile(config);
  const { envMap } = await loadStackMeta(config);

  const detectedImageEnvVar = getImageEnvVarFromStack(stackFileContent, envMap);
  const previousImage = getCurrentImageRef(envMap, stackFileContent);
  const usesEnvImage = Boolean(detectedImageEnvVar);

  let nextStackFileContent = stackFileContent;
  const nextEnvMap = new Map(envMap);
  let imageEnvVar = detectedImageEnvVar || 'ELIBO_MULTIPLICATION_GAME_IMAGE';
  let migratedLegacyEnv = false;

  if (detectedImageEnvVar === 'ELIBO_IMAGE') {
    nextStackFileContent = nextStackFileContent
      .replace(/\$\{ELIBO_IMAGE(?=[:}])/g, '${ELIBO_MULTIPLICATION_GAME_IMAGE')
      .replace(/\$ELIBO_IMAGE\b/g, '$ELIBO_MULTIPLICATION_GAME_IMAGE');

    if (!nextEnvMap.has('ELIBO_MULTIPLICATION_GAME_IMAGE') && nextEnvMap.has('ELIBO_IMAGE')) {
      nextEnvMap.set('ELIBO_MULTIPLICATION_GAME_IMAGE', String(nextEnvMap.get('ELIBO_IMAGE') || ''));
    }

    nextEnvMap.delete('ELIBO_IMAGE');
    imageEnvVar = 'ELIBO_MULTIPLICATION_GAME_IMAGE';
    migratedLegacyEnv = true;
  }

  if (usesEnvImage) {
    nextEnvMap.set(imageEnvVar, imageRef);
  } else {
    const replaced = replaceFirstImageRef(nextStackFileContent, imageRef);
    if (!replaced.replaced) {
      throw new Error(
        'Konnte in der Stack-Compose-Datei keine image:-Zeile finden. ' +
          'Nutze eine Compose-Datei mit image: ... oder ${ELIBO_MULTIPLICATION_GAME_IMAGE}.'
      );
    }
    nextStackFileContent = replaced.updated;
  }

  const reportedImageEnvVar = usesEnvImage ? imageEnvVar : '';

  const requestBody = {
    stackFileContent: nextStackFileContent,
    env: envMapToArray(nextEnvMap),
    prune: true,
    pullImage: true
  };

  const result = {
    stackId: config.stackId,
    endpointId: config.endpointId,
    source,
    previousImage,
    deployedImage: imageRef,
    usesEnvImage,
    imageEnvVar: reportedImageEnvVar,
    migratedLegacyEnv,
    dryRun
  };

  if (dryRun) {
    console.log(JSON.stringify({ ...result, requestBody }, null, 2));
    return;
  }

  await apiJson(
    config.baseUrl,
    `/api/stacks/${config.stackId}?endpointId=${encodeURIComponent(config.endpointId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(requestBody)
    },
    config.apiKey,
    10 * 60 * 1000
  );

  if (process.env.GITHUB_OUTPUT) {
    await BunLikeAppendFile(process.env.GITHUB_OUTPUT, `previous_image=${previousImage}\n`);
    await BunLikeAppendFile(process.env.GITHUB_OUTPUT, `deployed_image=${imageRef}\n`);
    await BunLikeAppendFile(process.env.GITHUB_OUTPUT, `uses_env_image=${usesEnvImage}\n`);
    await BunLikeAppendFile(process.env.GITHUB_OUTPUT, `image_env_var=${reportedImageEnvVar}\n`);
    await BunLikeAppendFile(process.env.GITHUB_OUTPUT, `migrated_legacy_env=${migratedLegacyEnv}\n`);
  }

  console.log(JSON.stringify(result, null, 2));
}

async function BunLikeAppendFile(filePath, content) {
  const fs = await import('node:fs/promises');
  await fs.appendFile(filePath, content, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();
    return;
  }

  if (!['inspect', 'deploy', 'wait-healthy'].includes(args.command)) {
    throw new Error(`Unbekannter Command: ${args.command}`);
  }

  const baseUrl = requiredEnv('PORTAINER_URL').replace(/\/+$/, '');
  const stackId = requiredEnv('PORTAINER_STACK_ID');
  const endpointId = requiredEnv('PORTAINER_ENDPOINT_ID');
  const apiKey = requiredEnv('PORTAINER_API_KEY');

  const config = {
    baseUrl,
    stackId,
    endpointId,
    apiKey,
    stackFilePath: args.stackFile || process.env.PORTAINER_STACK_FILE_PATH || ''
  };

  if (args.command === 'inspect') {
    await runInspect(config);
    return;
  }

  if (args.command === 'wait-healthy') {
    await runWaitHealthy(config, {
      image: args.image || process.env.DEPLOY_IMAGE || '',
      stackName: args.stackName || process.env.PORTAINER_STACK_NAME || '',
      timeoutSeconds: args.timeoutSeconds,
      intervalSeconds: args.intervalSeconds
    });
    return;
  }

  const imageRef = args.image || process.env.DEPLOY_IMAGE || '';
  if (!imageRef) {
    throw new Error('Für deploy wird ein Image benötigt: --image <ref> oder DEPLOY_IMAGE');
  }

  await runDeploy(config, imageRef, args.dryRun);
}

main().catch((error) => {
  console.error('\n❌ Portainer-Deploy fehlgeschlagen');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
