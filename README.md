# web-terminal

A browser terminal you can run on your own machine. It gives you real login
shells behind one password, with tabs that survive a closed browser, a key bar
for phones (Esc, Tab, Ctrl, Alt and arrows), and reconnects by itself after a
network drop.

It is a single small Node server, a plain TypeScript client on
[xterm.js](https://xtermjs.org/), and nothing else.

## What it gets right

- **Symbols and full-screen programs.** A code font ships with the page, with
  fallbacks for the marks most fonts leave out and for Nerd Font icons, so
  nothing depends on what the visitor has installed. Box drawing, blocks and
  powerline shapes are drawn rather than taken from a font, so they join up.
  Character widths follow Unicode 11, which is what tmux and most programs
  assume.
- **Reconnecting.** The server keeps its own copy of every screen. A browser
  that attaches later gets a clean snapshot (screen, scrollback, cursor, and
  modes such as the alternate screen and mouse reporting), not a replay of raw
  bytes, so vim, tmux and the like come back exactly as they were.
- **Light and dark.** Every theme keeps black dark and white light, and the
  terminal lifts any text that would be hard to read against its background.
  Programs written for dark terminals stay readable on a light one. Programs
  that ask are told which it is: `COLORFGBG`, the OSC 10/11 color queries, and
  mode 2031 (told again when the theme changes).
- **Your own look.** Eleven themes with a follow-the-system option, import of
  any color scheme in Windows Terminal's JSON format, four bundled fonts or any
  font installed on the device, size, line height and cursor. Settings stay in
  the browser.
- **Keys.** Ctrl+V pastes; Ctrl+C copies when text is selected and interrupts
  otherwise; Shift+Enter sends a line break to programs that take one; programs
  can copy to the clipboard with OSC 52 (never read it).
- **Phones.** A key bar with Esc, Tab, Ctrl, Alt, arrows and Paste, a layout
  that stays above the on-screen keyboard, and it installs as an app.

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
- After `npm run build`, `systemctl --user reload web-terminal` serves the new
  client without ending open shells. Restarting the service ends them, so run
  anything long-lived inside tmux.
- `deploy/Caddyfile.example` shows the proxy block. Caddy obtains the
  certificate and sets `X-Forwarded-For`.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `WEB_TERMINAL_PORT` | `3120` | Loopback port to listen on |
| `WEB_TERMINAL_MAX` | `8` | How many terminals can be open at once |
| `WEB_TERMINAL_DATA` | `var/` in the repo | Where the account and the session key are kept |

Shells start as login shells of `$SHELL` in the home directory, with
`TERM=xterm-256color` and a UTF-8 locale (`C.UTF-8` if the service has none).

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
client/   browser app (xterm.js, tabs, themes, settings, key bar)
deploy/   systemd unit and Caddy example
tools/    how the bundled fallback fonts were made
```

## Fonts

The code fonts come from [Fontsource](https://fontsource.org/) (JetBrains Mono,
Fira Code, Cascadia Code, IBM Plex Mono; SIL Open Font License). `client/fonts/`
holds two fallbacks built by `tools/subset-fonts.py`: symbols from
[JuliaMono](https://juliamono.netlify.app/) and icons from
[Nerd Fonts](https://www.nerdfonts.com/). Their licenses sit next to them.

## License

MIT. See [LICENSE](LICENSE).
