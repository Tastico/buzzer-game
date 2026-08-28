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

## Included mods

| Mod | Content |
|---|---|
| bible-quiz | 108 questions in categories with scripture references |

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
