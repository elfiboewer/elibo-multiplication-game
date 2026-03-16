#!/usr/bin/env node

import { appendFile } from 'node:fs/promises';
import process from 'node:process';

function usage() {
  console.log(`Usage:
  node scripts/ensure-portainer-stack.mjs --stack-name <name> [--external-port 8090] [--internal-port 80]
                                       [--image-env-var ELIBO_MULTIPLICATION_GAME_IMAGE] [--image-default ghcr.io/<owner>/elibo-multiplication-game:main]

Required environment:
  PORTAINER_URL
  PORTAINER_API_KEY
  PORTAINER_ENDPOINT_ID
`);
}

function parseArgs(argv) {
  const out = {
    stackName: '',
    externalPort: '8090',
    internalPort: '80',
    imageEnvVar: 'ELIBO_MULTIPLICATION_GAME_IMAGE',
    imageDefault: 'ghcr.io/elfiboewer/elibo-multiplication-game:main',
    bootstrapImage: 'nginx:alpine',
    help: false
  };

  const tokens = [...argv];
  while (tokens.length) {
    const token = tokens.shift();

    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }

    if (token === '--stack-name') {
      out.stackName = String(tokens.shift() || '').trim();
      continue;
    }

    if (token === '--external-port') {
      out.externalPort = String(tokens.shift() || out.externalPort).trim();
      continue;
    }

    if (token === '--internal-port') {
      out.internalPort = String(tokens.shift() || out.internalPort).trim();
      continue;
    }

    if (token === '--image-env-var') {
      out.imageEnvVar = String(tokens.shift() || out.imageEnvVar).trim();
      continue;
    }

    if (token === '--image-default') {
      out.imageDefault = String(tokens.shift() || out.imageDefault).trim();
      continue;
    }

    if (token === '--bootstrap-image') {
      out.bootstrapImage = String(tokens.shift() || out.bootstrapImage).trim();
      continue;
    }

    throw new Error(`Unbekanntes Argument: ${token}`);
  }

  return out;
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  }
  return value;
}

async function api(baseUrl, apiKey, path, method = 'GET', body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'X-API-Key': apiKey
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });

  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!res.ok) {
    throw new Error(
      `${method} ${path} -> ${res.status}: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`
    );
  }

  return payload;
}

function sanitizeImageEnvVar(name) {
  const normalized = String(name || '').trim();
  if (!normalized) return '';
  if (!/^[A-Z_][A-Z0-9_]*$/.test(normalized)) {
    throw new Error(`Ungültiger image env var Name: ${name}`);
  }
  return normalized;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();
    return;
  }

  const baseUrl = requiredEnv('PORTAINER_URL').replace(/\/+$/, '');
  const apiKey = requiredEnv('PORTAINER_API_KEY');
  const endpointId = requiredEnv('PORTAINER_ENDPOINT_ID');

  const stackName = String(args.stackName || '').trim();
  if (!stackName) {
    throw new Error('Bitte --stack-name angeben.');
  }

  const imageEnvVar = sanitizeImageEnvVar(args.imageEnvVar || 'ELIBO_MULTIPLICATION_GAME_IMAGE');
  const imageDefault = String(args.imageDefault || '').trim();
  const externalPort = String(args.externalPort || '').trim();
  const internalPort = String(args.internalPort || '').trim();
  const bootstrapImage = String(args.bootstrapImage || 'nginx:alpine').trim();

  if (!imageDefault) throw new Error('Bitte --image-default setzen.');
  if (!externalPort || !internalPort) throw new Error('Bitte --external-port und --internal-port setzen.');

  const compose = [
    'services:',
    `  ${stackName}:`,
    `    image: \${${imageEnvVar}:-${imageDefault}}`,
    `    container_name: ${stackName}`,
    '    restart: unless-stopped',
    '    ports:',
    `      - "${externalPort}:${internalPort}"`,
    '    healthcheck:',
    `      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:${internalPort}/health >/dev/null 2>&1 || exit 1"]`,
    '      interval: 30s',
    '      timeout: 5s',
    '      retries: 3',
    '      start_period: 20s',
    ''
  ].join('\n');

  const stacks = await api(baseUrl, apiKey, '/api/stacks', 'GET');
  const found = (Array.isArray(stacks) ? stacks : []).find((s) => {
    const name = String(s?.Name || s?.name || '');
    const eid = String(s?.EndpointId ?? s?.EndpointID ?? s?.endpointId ?? '');
    return name === stackName && eid === endpointId;
  });

  let stackId = found?.Id ?? found?.id;

  if (!stackId) {
    const env = [{ name: imageEnvVar, value: bootstrapImage }];

    const bodyLegacy = {
      Name: stackName,
      StackFileContent: compose,
      Env: env,
      FromAppTemplate: false
    };

    const bodyModern = {
      name: stackName,
      stackFileContent: compose,
      env,
      fromAppTemplate: false
    };

    const createAttempts = [
      {
        path: `/api/stacks/create/standalone/string?endpointId=${encodeURIComponent(endpointId)}`,
        body: bodyModern
      },
      {
        path: `/api/stacks/create/standalone/string?endpointId=${encodeURIComponent(endpointId)}`,
        body: bodyLegacy
      },
      {
        path: `/api/stacks/create/standalone/string?endpointId=${encodeURIComponent(endpointId)}&method=string&type=2`,
        body: bodyModern
      },
      {
        path: `/api/stacks?type=2&method=string&endpointId=${encodeURIComponent(endpointId)}`,
        body: bodyModern
      },
      {
        path: `/api/stacks?type=2&method=string&endpointId=${encodeURIComponent(endpointId)}`,
        body: bodyLegacy
      }
    ];

    let created = null;
    let lastError = null;

    for (const attempt of createAttempts) {
      try {
        created = await api(baseUrl, apiKey, attempt.path, 'POST', attempt.body);
        console.log(`Create stack succeeded via ${attempt.path}`);
        break;
      } catch (error) {
        lastError = error;
        console.warn(`Create attempt failed via ${attempt.path}: ${error?.message || error}`);
      }
    }

    if (!created) {
      throw lastError || new Error('Could not create Portainer stack');
    }

    stackId = created?.Id ?? created?.id;

    if (!stackId) {
      const restacks = await api(baseUrl, apiKey, '/api/stacks', 'GET');
      const refound = (Array.isArray(restacks) ? restacks : []).find((s) => {
        const name = String(s?.Name || s?.name || '');
        const eid = String(s?.EndpointId ?? s?.EndpointID ?? s?.endpointId ?? '');
        return name === stackName && eid === endpointId;
      });
      stackId = refound?.Id ?? refound?.id;
    }

    if (!stackId) {
      throw new Error('Stack created but could not resolve stack id');
    }

    console.log(`Created stack '${stackName}' with id=${stackId}`);
  } else {
    console.log(`Stack '${stackName}' already exists with id=${stackId}`);
  }

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `stack_id=${stackId}\n`, 'utf8');
  }

  console.log(
    JSON.stringify(
      {
        stackId,
        stackName,
        endpointId,
        externalPort,
        internalPort,
        imageEnvVar,
        imageDefault
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
