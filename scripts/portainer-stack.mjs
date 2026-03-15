#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';

function usage() {
  console.log(`Usage:
  node scripts/portainer-stack.mjs inspect [--stack-file <path>]
  node scripts/portainer-stack.mjs deploy --image <image-ref> [--stack-file <path>] [--dry-run]

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
`);
}

const IMAGE_ENV_PRIORITY = ['ELIBO_MULTIPLICATION_GAME_IMAGE', 'ELIBO_IMAGE'];

function parseArgs(argv) {
  const out = {
    command: 'inspect',
    image: '',
    stackFile: '',
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

  if (!['inspect', 'deploy'].includes(args.command)) {
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
