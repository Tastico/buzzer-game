# Buzzer Game

A LAN game-show buzzer system. Players join from their phones, buzz in, answer questions from pluggable quiz mods, and the host runs everything from an admin panel.

Built for real living rooms: zero setup on player devices (they just open a QR code), works over plain Wi-Fi, no internet required.

## Quick start

```bash
npm install
node server.js
```

Or use the launchers: start.bat (Windows), start.ps1 (Windows PowerShell), start.sh (Linux/macOS).

Open `http://<host-ip>:3000` (the server prints its LAN IP; players can scan the QR page). The admin panel is at `/admin`.

Set the admin password before first use:

```bash
BUZZER_ADMIN_PASSWORD=your-password node server.js
```

The default (changeme) is meant only for a quick LAN test. Port is configurable with `PORT`.

## Features

- Players join from any browser, no app install
- Buzz-in with a configurable judgment timeout for the host
- Pluggable quiz mods (questions, player UI, admin UI)
- QR code page so phones can join instantly
- Three standalone HTML theme variants in variants/
- Spectator mode: a "Watch only" button on the join screen; viewers see live scores and buzz order and cannot buzz
- Server-side answer timer (10s): if the host does not judge in time, the round ends automatically

## Included mods

| Mod | Content |
|---|---|
| bible-quiz | 126 questions across 10 categories (standard, fill-in-the-blank, wrong-word, guess-the-source) plus an Akinator-style character guessing mode |

### Bible Quiz 2.1 highlights

- Answer privacy: after a buzz, the answer is revealed ONLY to the player who buzzed; everyone else sees a hidden notice without the answer text
- Theme filter: pick one category (or all) in the admin panel; every round draws only from that theme
- Wrong-word questions: the question is a verse with one wrong word, the host reads the options
- Guess-the-source questions: verse text shown, players guess the Bible book
- Akinator mode: yes/no questions narrow down a Bible character (25 characters in questions-akinator.json, a starter dataset; extend freely)
- Questions data: mods/bible-quiz/questions.json (add a "type" field: standard, fill, wrong_word, guess_source)

## Tests

```bash
# terminal 1
PORT=3999 node server.js
# terminal 2
node test/smoke.js
```

The smoke test exercises the full flow: join, spectator rejection, mod activation, theme filter, winner-only answer reveal, the 10s timer, and Akinator.

## Build your own mod

Drop a folder in mods/ with:

- mod.json: name, description, colors
- main.js: game logic hooks
- player-ui.js: what players see
- admin-ui.js: what the host sees
- questions.json: question bank

See mods/bible-quiz for a complete example.

## Structure

| Path | What it is |
|---|---|
| server.js | WebSocket server + static file hosting |
| lib/mod-loader.js | Mod discovery and loading |
| public/ | Player, admin, debug, and QR pages |
| mods/ | Quiz mods |
| variants/ | Standalone HTML theme variants |
| deps-install.js | Dependency installer without npm |

## License

MIT.
