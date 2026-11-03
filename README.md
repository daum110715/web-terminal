# web-terminal

A browser terminal you can run on your own machine. It gives you real login
shells behind one password, with tabs that survive a closed browser, a key bar
for phones (Esc, Tab, Ctrl, Alt and arrows), and reconnects by itself after a
network drop.

It is a single small Node server, a plain TypeScript client on
[xterm.js](https://xtermjs.org/), and nothing else.

## Requirements

- Node.js 24 or newer
- A C/C++ toolchain for `node-pty` (`build-essential` on Debian/Ubuntu, Xcode
  command line tools on macOS)
- A reverse proxy that serves HTTPS, such as Caddy (see `deploy/`)

## Quick start

```sh
npm ci
npm run build          # bundles the client into client/dist
npm run passwd         # sets the one account (interactive)
npm start              # listens on http://127.0.0.1:3120
```

For non-interactive setup, pipe the password on stdin and pass the name:

```sh
printf '%s\n' "$PASSWORD" | WEB_TERMINAL_USERNAME=alice npm run passwd
```

Open the address through your HTTPS proxy and sign in. The server only listens
on loopback, so it is never reachable directly from the network.

## Deploying

- `deploy/web-terminal.service` is a systemd user unit. Copy it to
  `~/.config/systemd/user/`, fix the Node path, then
  `systemctl --user enable --now web-terminal`.
- `deploy/Caddyfile.example` shows the proxy block. Caddy obtains the
  certificate and sets `X-Forwarded-For`.

## Security notes

- A shell here runs as the account that starts the server, with that account's
  permissions. If that account can use `sudo` without a password, anyone who
  signs in can too. Run it as an unprivileged user.
- One account, scrypt-hashed password, and an HMAC-signed `Secure` session
  cookie that lasts 90 days. Changing the password signs out every session.
- Login is throttled per client address, with lockouts that double after five
  failures. The address is the last `X-Forwarded-For` hop when the peer is
  loopback, so only run it behind a proxy you control.
- Mutating API calls and WebSockets must come from the same origin.
- Responses carry a strict Content-Security-Policy and framing is denied.

Treat the password as a root-equivalent secret if your shell account is
privileged, and consider putting an access layer (for example, IP allow-lists or
a VPN) in front of it.

## Development

```sh
npm run check          # type-check the server and the client
npm test               # server unit tests
npm run build          # rebuild the client after editing client/
```

Layout:

```
server/   HTTP API, WebSocket attach, shells, auth, static assets
client/   browser app (xterm.js, tabs, key bar)
deploy/   systemd unit and Caddy example
```

## License

MIT. See [LICENSE](LICENSE).
