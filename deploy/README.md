# Linux Deployment Without Docker

The game runs as a single Node.js process. Use Node.js 20 or newer and install
dependencies with `npm ci --omit=dev`. Accounts, wallets, history and room
snapshots are stored in SQLite. Keep `data/dezhou.db` and its WAL files in the
persistent data directory across releases; the current unit permits writes to
`/home/admin/dezhou-data`, exposed to the application through its `data` path.
Schedule updates when the lobby is empty and retain a database backup.

On the current Alibaba Cloud Linux host, the packaged `better-sqlite3` Linux
binary requires a newer glibc. Use the already installed Python 3.11 to build
the native module locally; the system's default Python 3.6 cannot run node-gyp.
Run this in each new release directory before starting the application:

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
if ! node -e 'const D=require("better-sqlite3"); new D(":memory:").close()'; then
  if [ -f node_modules/better-sqlite3/prebuilds/linux-x64.node ]; then
    mv node_modules/better-sqlite3/prebuilds/linux-x64.node \
      node_modules/better-sqlite3/prebuilds/linux-x64.node.disabled
  fi
  PYTHON=/usr/bin/python3.11 npm rebuild better-sqlite3
fi
node -e 'const D=require("better-sqlite3"); new D(":memory:").close()'
```

The module prefers its packaged binary even after a local build, so disable
that incompatible binary before rebuilding. Do not change the system glibc or
the global Python default. To run tests on the host, install with `--include=dev`
instead of `--omit=dev`, then prune using `npm prune --omit=dev --ignore-scripts`.

`serve.js` is the managed-service entry point. It listens on `HOST` (default
`127.0.0.1`) and `PORT` (default `3210`), and exits if that port is unavailable.
The desktop `npm start` command retains its automatic port selection.

## systemd

`dezhou.service` is configured for the current Alibaba Cloud Linux host:

- User and group: `admin`
- Node.js: `/usr/bin/node`
- Application symlink: `/home/admin/dezhou-current`
- Versioned application directories: `/home/admin/dezhou-releases/`
- Listener: `0.0.0.0:3210`

Adjust these paths and the user for other hosts. Install a release and its
dependencies before pointing the application symlink at it. Then install the
unit with `sudo install -m 0644 deploy/dezhou.service /etc/systemd/system/dezhou.service`,
run `sudo systemctl daemon-reload`, and `sudo systemctl enable --now dezhou`.
Stop any earlier manually started game on the same port before starting the unit.

```sh
sudo systemctl status dezhou --no-pager
sudo journalctl -u dezhou -n 80 --no-pager
sudo systemctl restart dezhou
curl --fail http://127.0.0.1:3210/api/health
```

To update, prepare a separate release, install dependencies, and validate it
before changing `/home/admin/dezhou-current` and restarting the service. Retain
the prior release so the symlink can be restored if needed. Preserve the shared
database when changing application releases. Poker restores seats and chips after
an unexpected restart but voids an unfinished hand; a graceful poker shutdown
refunds table chips. Mahjong saves its full wall, hands, responses and settlements,
so an unfinished round resumes after either kind of restart. Returning Mahjong
players receive a normal turn window (20 seconds by default) before unattended
play continues; offline seats in a waiting or completed room are refunded.

## Public Access

The current IP-based setup needs an inbound TCP rule for port 3210 in the cloud
firewall. The public URL must use the server's public address, not its private
172.x address. The service continues after SSH disconnects and starts at boot.

For a domain and HTTPS, use a reverse proxy that supports both Socket.IO HTTP
polling and WebSocket upgrades. Proxy all game traffic to the same instance;
switch `HOST` to `127.0.0.1` when the proxy is on this server. Keep only one game
process; there is no shared room storage for load-balanced workers.

The current lobby is public and does not enforce room passwords. IP-based HTTP
does not encrypt traffic. `/api/network` reports LAN addresses and is not the
public invitation address; a public reverse proxy can block that endpoint.
