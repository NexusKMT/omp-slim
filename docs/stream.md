# Stream: Livestream Your Terminal

`omp stream` broadcasts your omp sessions to `live.omp.sh/<channel>` — a Twitch-style page with the live terminal and a chat column. Viewers see exactly what your terminal shows (minus secrets); they cannot type into the session.

Stream is independent from [Collab](collab.md). Collab replicates the session itself (entries, events, prompts) to guests who can drive the agent; Stream sends only rendered screen rows, one way, to an audience.

## Quick start

In the directory you work in:

```
omp stream my-channel --title "Refactoring the parser"
```

prints

```
● live.omp.sh/my-channel  "Refactoring the parser"
  waiting for sessions in /work/proj …
```

Then start omp in the same directory from another terminal (as many times as you like). Each session started while `omp stream` runs attaches automatically and shows `● LIVE 3` in its footer (`3` = current viewers). The viewer page shows each session as its own pane; a pane disappears when its session exits. Ctrl-C in the streamer ends the broadcast and every attached session drops its badge.

Sessions that were already running before `omp stream` started are not attached — restart them.

### Streamer console

| Input           | Effect                                        |
| --------------- | --------------------------------------------- |
| `<text>` + Enter | Send a chat message as the streamer          |
| `/title <text>` | Change the stream title                       |
| Ctrl-C          | Stop streaming (sessions detach, channel goes offline) |

The console also prints pane attach/detach lines, viewer-count changes, and every chat message.

### Options and settings

| Flag / setting            | Meaning                                                                          |
| ------------------------- | -------------------------------------------------------------------------------- |
| `<channel>`               | Path segment of the viewer URL: lowercase letters, digits, dashes; 1–32 chars     |
| `--title <text>`          | Stream title (default: directory name)                                           |
| `--server <url>`          | Stream server base (default: `stream.serverUrl`)                                 |
| `stream.serverUrl`        | Default server, `https://live.omp.sh`                                            |
| `stream.redactPatterns`   | Extra regular expressions masked from every streamed row                         |

## What leaves the machine

Only terminal rows. The session process:

1. Takes the rows the TUI just painted (scrollback commits and the live viewport).
2. Strips every escape except text styling (SGR) and hyperlinks (OSC 8); inline images become `[image]`.
3. **Redacts** the row (below).
4. Diffs against the last sent viewport and sends row patches — never session entries, prompts, tool arguments, or file contents as data.

Rows cross a private local socket (`0600`, under the per-directory omp runtime dir) to the `omp stream` process, which multiplexes sessions into panes and forwards them to the server in plaintext over WSS. The server keeps each pane's viewport and the last 2000 history rows in memory so late viewers get a snapshot; nothing is persisted.

### Redaction

Redaction is irreversible and intentionally over-matches. Any match replaces the run with `••••••`; a row with a match is sent unstyled. Sources:

- Values of environment variables whose names look secret (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, …) and every value loaded from a `.env` file for the directory, regardless of name (8+ chars).
- `.omp/secrets.yml` and `~/.omp/agent/secrets.yml` entries.
- Credential shapes (GitHub/GitLab/OpenAI/Anthropic/AWS/Slack/Stripe/npm/HF tokens, JWTs, PEM blocks, `Bearer …`). Vendor prefixes are matched **without** a length gate so a token is masked while it is still being typed or streamed character by character.
- `NAME=value`, `NAME: value`, `"NAME": "value"` where `NAME` looks secret — the value is masked (covers `read .env` and config files on screen).
- Passwords in connection URLs (`scheme://user:password@host`).
- `stream.redactPatterns`.

Known plain values are also matched by prefix (6+ characters) so a partially typed secret is masked before it is complete.

Redaction cannot know about secrets it has never seen: a token pasted from elsewhere that matches no shape and no configured value is shown. Use `stream.redactPatterns` or `secrets.yml` for anything unusual, and prefer pausing: viewers of a paused pane see a `BRB` card.

## Server

`live.omp.sh` is a small Go service (stencil `apps/live`): channel directory (`GET /api/channels`, `GET /api/channels/<name>`), homepage previews (`GET /api/channels/<name>/preview` — the first pane's viewport, never counted as a viewer), one host socket per channel (`/ws/host/<name>`), viewer sockets (`/ws/watch/<name>`), chat with per-viewer rate limiting, and the web UI (terminal rows render in the full Berkeley Mono Nerd Font served from `/fonts/`). Wire shapes live in `@oh-my-pi/pi-wire/stream`.

Channel names are first-come per server process; accounts and ownership are on the way. Until then, if `omp stream` reports `channel already has a live host`, pick another name.
