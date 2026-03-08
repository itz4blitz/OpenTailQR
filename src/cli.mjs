#!/usr/bin/env node

import http from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { promisify } from 'node:util';
import qrcode from 'qrcode-terminal';

const execFile = promisify(execFileCallback);

const DEFAULTS = {
  apiUrl: 'http://127.0.0.1:4096',
  targetPath: '/',
  managerPath: '/',
  username: process.env.OPENCODE_SERVER_USERNAME || 'opencode',
  password: process.env.OPENCODE_SERVER_PASSWORD || '',
  ttl: 300,
  bind: '0.0.0.0',
  bridgePort: 0,
};

function helpText() {
  return [
    'OpenTailQR',
    '',
    'Generate QR links for onboarding phones and new devices to Tailscale-hosted tools.',
    '',
    'Usage:',
    '  opentailqr [options]',
    '',
    'Options:',
    '  --api-url <url>       OpenCode API URL (default: http://127.0.0.1:4096)',
    '  --target-url <url>    URL that your phone should open',
    '  --target-path <path>  Path to open on the target URL (default: /)',
    '  --manager             Build a direct QR for OpenCode Manager over Tailscale HTTPS',
    '  --manager-path <path> Path on OpenCode Manager (default: /)',
    '  --host <host>         Public host for QR link (defaults to Tailscale DNS)',
    '  --username <name>     Basic auth username (default: opencode)',
    '  --password <value>    Basic auth password (default: OPENCODE_SERVER_PASSWORD)',
    '  --embed-auth          Embed basic auth in direct QR URL (less secure)',
    '  --command <value>     Run /tui/execute-command when QR is opened',
    '  --session <id>        Run /tui/select-session before redirect',
    '  --bridge              Force one-time bridge mode',
    '  --no-bridge           Disable bridge mode (cannot be used with --command/--session)',
    '  --bridge-port <port>  Bridge listen port (default: 0, random)',
    '  --bind <addr>         Bridge bind address (default: 0.0.0.0)',
    '  --ttl <seconds>       One-time link expiration (default: 300)',
    '  --keep-alive          Keep bridge alive after first scan',
    '  -h, --help            Show help',
    '',
    'Examples:',
    '  opentailqr --manager',
    '  opentailqr --manager --manager-path /settings',
    '  opentailqr --target-url https://your-machine.your-tailnet.ts.net',
    '  opentailqr --target-path /doc',
    '  opentailqr --command open-help',
    '  opentailqr --bridge --session ses_abc123 --target-path /',
  ].join('\n');
}

function fail(message) {
  throw new Error(message);
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined) {
    fail(`Missing value for ${flag}`);
  }
  return value;
}

function toInteger(raw, label) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    fail(`Invalid ${label}: ${raw}`);
  }
  return value;
}

function parseArgs(argv) {
  const opts = {
    ...DEFAULTS,
    help: false,
    forceBridge: false,
    noBridge: false,
    manager: false,
    keepAlive: false,
    embedAuth: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--api-url':
        opts.apiUrl = readValue(argv, i, arg);
        i += 1;
        break;
      case '--target-url':
        opts.targetUrl = readValue(argv, i, arg);
        i += 1;
        break;
      case '--target-path':
        opts.targetPath = readValue(argv, i, arg);
        i += 1;
        break;
      case '--manager':
        opts.manager = true;
        break;
      case '--manager-path':
        opts.managerPath = readValue(argv, i, arg);
        i += 1;
        break;
      case '--host':
        opts.host = readValue(argv, i, arg);
        i += 1;
        break;
      case '--username':
        opts.username = readValue(argv, i, arg);
        i += 1;
        break;
      case '--password':
        opts.password = readValue(argv, i, arg);
        i += 1;
        break;
      case '--command':
        opts.command = readValue(argv, i, arg);
        i += 1;
        break;
      case '--session':
        opts.session = readValue(argv, i, arg);
        i += 1;
        break;
      case '--ttl':
        opts.ttl = toInteger(readValue(argv, i, arg), 'ttl');
        i += 1;
        break;
      case '--bridge-port':
        opts.bridgePort = toInteger(readValue(argv, i, arg), 'bridge port');
        i += 1;
        break;
      case '--bind':
        opts.bind = readValue(argv, i, arg);
        i += 1;
        break;
      case '--bridge':
        opts.forceBridge = true;
        break;
      case '--no-bridge':
        opts.noBridge = true;
        break;
      case '--keep-alive':
        opts.keepAlive = true;
        break;
      case '--embed-auth':
        opts.embedAuth = true;
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function normalizePath(pathname) {
  if (!pathname) {
    return '/';
  }
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

function baseUrl(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

function buildManagerUrl(publicHost, pathname) {
  if (!publicHost) {
    fail('Could not determine public host for OpenCode Manager. Pass --host explicitly.');
  }

  const url = new URL(`https://${publicHost}`);
  url.pathname = normalizePath(pathname);
  url.search = '';
  url.hash = '';
  return url;
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function maskedUrl(raw) {
  const parsed = new URL(raw);
  if (parsed.password) {
    parsed.password = '********';
  }
  return parsed.toString();
}

async function detectTailscaleHost() {
  try {
    const { stdout } = await execFile('tailscale', ['status', '--json']);
    const data = JSON.parse(stdout);
    const dnsName = data?.Self?.DNSName;
    if (typeof dnsName === 'string' && dnsName.length > 0) {
      return dnsName.endsWith('.') ? dnsName.slice(0, -1) : dnsName;
    }
  } catch {
    // Best effort only.
  }

  try {
    const { stdout } = await execFile('tailscale', ['ip', '-4']);
    const first = stdout
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
    if (first) {
      return first;
    }
  } catch {
    // Best effort only.
  }

  return null;
}

function buildAuthHeader(opts) {
  if (!opts.password) {
    return null;
  }
  const token = Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
  return `Basic ${token}`;
}

async function apiRequest(opts, path, method = 'GET', body = undefined) {
  const url = new URL(path.replace(/^\//, ''), baseUrl(opts.apiUrl));
  const headers = {
    Accept: 'application/json',
  };

  const authHeader = buildAuthHeader(opts);
  if (authHeader) {
    headers.Authorization = authHeader;
  }

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    fail(`Could not reach OpenCode at ${url.origin}. ${error.message}`);
  }

  if (!response.ok) {
    const text = await response.text();
    const details = text.length > 300 ? `${text.slice(0, 300)}...` : text;
    fail(`${method} ${path} failed (${response.status}): ${details}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

function resolvedTargetUrl(opts, publicHost) {
  if (opts.targetUrl) {
    return new URL(opts.targetUrl);
  }

  if (opts.manager) {
    return buildManagerUrl(publicHost, opts.managerPath);
  }

  const api = new URL(opts.apiUrl);
  if (publicHost) {
    api.hostname = publicHost;
  }
  api.pathname = normalizePath(opts.targetPath);
  api.search = '';
  api.hash = '';

  if (opts.embedAuth && opts.password) {
    api.username = opts.username;
    api.password = opts.password;
  } else {
    api.username = '';
    api.password = '';
  }

  return api;
}

function printQr(url, heading) {
  console.log('');
  console.log(heading);
  qrcode.generate(url, { small: true });
  console.log(`URL: ${maskedUrl(url)}`);
  console.log('');
}

function buildScanUrl(host, port, token) {
  const url = new URL('http://localhost');
  url.hostname = host;
  url.port = String(port);
  url.pathname = `/${token}`;
  return url.toString();
}

function actionRows(options, result) {
  const rows = [];
  if (options.session) {
    rows.push(`Session select: ${result.sessionOk ? 'ok' : 'failed'}`);
  }
  if (options.command) {
    rows.push(`TUI command: ${result.commandOk ? 'ok' : 'failed'}`);
  }
  if (result.error) {
    rows.push(`Error: ${result.error.message}`);
  }
  return rows;
}

function landingPage({ targetUrl, result }) {
  const rows = actionRows(result.options, result)
    .map((row) => `<li>${escapeHtml(row)}</li>`)
    .join('');

  const status = result.error ? 'Action failed' : 'Ready';
  const subtitle = result.error
    ? 'OpenCode redirect is still available below.'
    : 'Action completed. Redirecting now...';

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenCode QR</title>
    <meta http-equiv="refresh" content="1;url=${escapeHtml(targetUrl)}" />
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; padding: 1.5rem; background: #0b1021; color: #f1f5f9; }
      .card { max-width: 640px; margin: 0 auto; background: #111937; border: 1px solid #30417a; border-radius: 12px; padding: 1rem 1.2rem; }
      a { color: #8cc8ff; }
      ul { padding-left: 1.25rem; }
      code { background: #1b2652; padding: 0.1rem 0.3rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>${escapeHtml(status)}</h2>
      <p>${escapeHtml(subtitle)}</p>
      <ul>${rows}</ul>
      <p><a href="${escapeHtml(targetUrl)}">Continue to OpenCode</a></p>
      <p><small>Target: <code>${escapeHtml(maskedUrl(targetUrl))}</code></small></p>
    </div>
  </body>
</html>`;
}

async function runBridge(opts, targetUrl, publicHost) {
  const token = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + opts.ttl * 1000;
  let used = false;
  let shuttingDown = false;
  let timeoutHandle;

  const cleanupListeners = [];

  const server = http.createServer(async (req, res) => {
    const now = Date.now();
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (reqUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (reqUrl.pathname !== `/${token}`) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    if (now > expiresAt) {
      res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('QR link expired. Generate a new one.');
      return;
    }

    if (used && !opts.keepAlive) {
      res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('QR link already used. Generate a new one.');
      return;
    }

    used = true;
    const result = {
      options: opts,
      sessionOk: true,
      commandOk: true,
      error: null,
    };

    try {
      if (opts.session) {
        await apiRequest(opts, '/tui/select-session', 'POST', { sessionID: opts.session });
      }
      if (opts.command) {
        await apiRequest(opts, '/tui/execute-command', 'POST', { command: opts.command });
      }
    } catch (error) {
      if (opts.session) {
        result.sessionOk = false;
      }
      if (opts.command) {
        result.commandOk = false;
      }
      result.error = error;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(landingPage({ targetUrl: targetUrl.toString(), result }));

    if (!opts.keepAlive) {
      setTimeout(() => {
        if (!shuttingDown) {
          shuttingDown = true;
          server.close();
        }
      }, 1000);
    }
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.bridgePort, opts.bind, resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    fail('Could not determine bridge listening port');
  }

  const scanUrl = buildScanUrl(publicHost, address.port, token);
  printQr(scanUrl, 'Scan this one-time QR from your phone:');
  console.log(`Expires in: ${opts.ttl}s`);
  console.log(`Bridge bind: ${opts.bind}:${address.port}`);
  console.log(`After scan redirect: ${maskedUrl(targetUrl.toString())}`);
  console.log('');

  timeoutHandle = setTimeout(() => {
    if (!shuttingDown) {
      shuttingDown = true;
      console.log('QR link expired. Bridge stopped.');
      server.close();
    }
  }, opts.ttl * 1000 + 250);

  await new Promise((resolve) => {
    server.on('close', resolve);

    const stop = () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      console.log('Stopping bridge...');
      server.close();
    };

    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    cleanupListeners.push(() => process.off('SIGINT', stop));
    cleanupListeners.push(() => process.off('SIGTERM', stop));
  });

  clearTimeout(timeoutHandle);
  cleanupListeners.forEach((fn) => fn());
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(helpText());
    return;
  }

  const tailscaleHost = opts.host || (await detectTailscaleHost());
  const target = resolvedTargetUrl(opts, tailscaleHost);
  const publicHost = opts.host || tailscaleHost || target.hostname;

  if (opts.manager && (opts.command || opts.session || opts.forceBridge || opts.embedAuth)) {
    fail('--manager only supports direct QR links. Remove bridge, command, session, and embed-auth options.');
  }

  if (opts.noBridge && (opts.command || opts.session)) {
    fail('--no-bridge cannot be used with --command or --session');
  }

  const useBridge = !opts.manager && !opts.noBridge && (opts.forceBridge || Boolean(opts.command || opts.session));
  if (useBridge || (!opts.manager && !opts.targetUrl)) {
    await apiRequest(opts, '/global/health');
  }

  if (useBridge) {
    if (!publicHost) {
      fail('Could not determine public host for bridge URL. Pass --host explicitly.');
    }
    await runBridge(opts, target, publicHost);
    return;
  }

  printQr(target.toString(), 'Scan this QR from your phone:');
  if (isLoopback(target.hostname)) {
    console.log('Warning: QR URL points to loopback. Use --host or connect through Tailscale.');
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
