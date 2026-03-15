#!/usr/bin/env node

import process from 'node:process';

function usage() {
  console.log(`Usage:
  node scripts/wait-health.mjs --url <https://example/api/status> [--timeout 300] [--interval 8]

Environment alternatives:
  HEALTHCHECK_URL
  HEALTHCHECK_TIMEOUT_SECONDS (default 300)
  HEALTHCHECK_INTERVAL_SECONDS (default 8)
  HEALTHCHECK_REQUIRE_ALL_SERVICES (default 1)
`);
}

function parseArgs(argv) {
  const out = {
    url: '',
    timeout: Number(process.env.HEALTHCHECK_TIMEOUT_SECONDS || 300),
    interval: Number(process.env.HEALTHCHECK_INTERVAL_SECONDS || 8),
    requireAllServices: process.env.HEALTHCHECK_REQUIRE_ALL_SERVICES !== '0',
    help: false
  };

  const tokens = [...argv];
  while (tokens.length) {
    const token = tokens.shift();

    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }

    if (token === '--url') {
      out.url = String(tokens.shift() || '');
      continue;
    }

    if (token === '--timeout') {
      out.timeout = Number(tokens.shift() || out.timeout);
      continue;
    }

    if (token === '--interval') {
      out.interval = Number(tokens.shift() || out.interval);
      continue;
    }

    if (token === '--no-require-all-services') {
      out.requireAllServices = false;
      continue;
    }

    throw new Error(`Unbekanntes Argument: ${token}`);
  }

  return out;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function evaluateHealth(json, requireAllServices) {
  const appOk = Boolean(json?.ok);

  if (!requireAllServices) {
    return {
      healthy: appOk,
      reason: appOk ? 'ok' : 'json.ok != true'
    };
  }

  if (!json?.services || typeof json.services !== 'object') {
    return {
      healthy: appOk,
      reason: appOk ? 'ok (no services object present)' : 'json.ok != true'
    };
  }

  const services = Object.values(json.services);
  const failing = services.filter((service) => !service?.health?.ok).map((service) => service?.key || service?.label || 'unknown');

  if (!appOk) {
    return {
      healthy: false,
      reason: 'json.ok != true'
    };
  }

  if (failing.length > 0) {
    return {
      healthy: false,
      reason: `services unhealthy: ${failing.join(', ')}`
    };
  }

  return {
    healthy: true,
    reason: 'ok'
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();
    return;
  }

  const url = args.url || process.env.HEALTHCHECK_URL || '';
  if (!url) {
    throw new Error('Bitte HEALTHCHECK_URL setzen oder --url angeben.');
  }

  if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
    throw new Error('Timeout muss > 0 Sekunden sein.');
  }

  if (!Number.isFinite(args.interval) || args.interval <= 0) {
    throw new Error('Intervall muss > 0 Sekunden sein.');
  }

  const deadline = Date.now() + args.timeout * 1000;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(args.interval, 10) * 1000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      const text = await res.text();
      let json = null;

      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (res.ok && json) {
        const state = evaluateHealth(json, args.requireAllServices);
        if (state.healthy) {
          console.log(`✅ Healthcheck erfolgreich nach ${attempt} Versuch(en): ${state.reason}`);
          return;
        }

        console.log(`⏳ Versuch ${attempt}: noch nicht healthy (${state.reason})`);
      } else if (res.ok && !json) {
        console.log(`✅ Healthcheck erfolgreich nach ${attempt} Versuch(en): HTTP ${res.status}`);
        return;
      } else {
        console.log(`⏳ Versuch ${attempt}: HTTP ${res.status}`);
      }
    } catch (error) {
      console.log(`⏳ Versuch ${attempt}: request failed (${String(error?.message || error)})`);
    }

    await sleep(args.interval * 1000);
  }

  throw new Error(`Healthcheck Timeout nach ${args.timeout}s: ${url}`);
}

main().catch((error) => {
  console.error('\n❌ Healthcheck fehlgeschlagen');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
