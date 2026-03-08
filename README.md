# OpenTailQR

`OpenTailQR` prints QR codes for Tailscale-hosted developer tools so you can jump from desktop to phone without typing long tailnet URLs.

It supports two main workflows:

- direct links to OpenCode Manager or any other Tailscale URL
- one-time bridge links for OpenCode web/TUI actions before redirect

`opencode-qr` is kept as a backwards-compatible CLI alias.

## Why this exists

- No manual typing of Tailscale hostnames on mobile
- One command on desktop, one scan on phone
- Optional one-time link with expiration for safer OpenCode actions

## Install

```bash
cd ~/Development/OpenTailQR
npm install
npm link
```

Now these commands are available globally:

- `opentailqr`
- `opencode-qr`

## Quick start

### OpenCode Manager over Tailscale HTTPS

Generate a QR that opens your local OpenCode Manager deployment:

```bash
opentailqr --manager
```

Open a specific page on the manager:

```bash
opentailqr --manager --manager-path /settings
```

### Any direct Tailscale URL

```bash
opentailqr --target-url https://blitzs-mac-studio.taild1bbf.ts.net
```

### OpenCode web server

Make sure your OpenCode server is running on the Mac, for example:

```bash
OPENCODE_SERVER_PASSWORD='your-password' opencode web --hostname 0.0.0.0 --port 4096
```

Then generate a QR:

```bash
opentailqr
```

By default it auto-detects your Tailscale DNS name and uses `http://<tailscale-host>:4096/`.

## Useful commands

Open OpenCode API docs directly:

```bash
opentailqr --target-path /doc
```

Set an explicit host:

```bash
opentailqr --host blitzs-mac-studio.taild1bbf.ts.net
```

Use one-time bridge mode and run a TUI command before redirect:

```bash
opentailqr --command open-help
```

Use one-time bridge mode and select a session before redirect:

```bash
opentailqr --session ses_abc123
```

## Security notes

- Prefer Tailscale networking over opening LAN ports.
- Keep `OPENCODE_SERVER_PASSWORD` set when using OpenCode auth.
- By default, passwords are not embedded in QR links.
- `--embed-auth` is available but less secure, because credentials are encoded in the URL.
- Bridge mode runs actions server-side, but does not replace OpenCode login unless you use `--embed-auth`.

## Options

```text
--api-url <url>       OpenCode API URL (default: http://127.0.0.1:4096)
--target-url <url>    URL that your phone should open
--target-path <path>  Path to open on the target URL (default: /)
--manager             Build a direct QR for OpenCode Manager over Tailscale HTTPS
--manager-path <path> Path on OpenCode Manager (default: /)
--host <host>         Public host for QR link (defaults to Tailscale DNS)
--username <name>     Basic auth username (default: opencode)
--password <value>    Basic auth password (default: OPENCODE_SERVER_PASSWORD)
--embed-auth          Embed basic auth in direct QR URL (less secure)
--command <value>     Run /tui/execute-command when QR is opened
--session <id>        Run /tui/select-session before redirect
--bridge              Force one-time bridge mode
--no-bridge           Disable bridge mode (cannot be used with --command/--session)
--bridge-port <port>  Bridge listen port (default: 0, random)
--bind <addr>         Bridge bind address (default: 0.0.0.0)
--ttl <seconds>       One-time link expiration (default: 300)
--keep-alive          Keep bridge alive after first scan
```
