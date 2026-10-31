# SugoiBot

A modern, modular, and scalable Discord bot framework and web dashboard built with **Node.js (ESM)** and **Discord.js v14**.

---

## 🚀 Features

- **🧩 Plug-and-Play Modularity**: Drop any folder into `modules/` to instantly add slash commands, events, and settings.
- **🌐 Web Management Dashboard**: Built with Express v5 featuring Discord OAuth2 authentication, server selector for administrators, and live per-guild configuration toggles.
- **🔊 Temporary Voice Rooms**: Dynamic *Join-to-Create* voice hubs (`/voice setup`) that automatically spawn private rooms, post interactive control buttons (`🔒 Lock`, `🔓 Unlock`, `👻 Ghost`, `👀 Unhide`, `✏️ Rename`, `👥 Limit`, `👑 Claim`) directly into the room's chat box, and auto-delete when empty. Supports multiple concurrent hubs and cross-server room name persistence.
- **🎮 GameRole System**: Automatically assigns and removes roles based on member Discord Rich Presence playing status (`/gamerole`), with 84 built-in popular games and server-specific whitelist overrides.
- **🎨 Visual Canvas Cards**: High-performance graphical rank cards (`/rank`) and multi-row server leaderboards (`/leaderboard`) generated dynamically via `@napi-rs/canvas`.
- **📜 Granular Server Audit Logging**: Centralized embed logging with user avatar headers, clean action summaries, and native relative timestamps:
  - Member joins with **invite tracking** (identifies who created the invite and code used)
  - Member leaves and avatar change auditing (showing previous vs. new profile pictures)
  - Message deletions (with uncached message support)
  - Channel creation & deletion (identifying who created or deleted the channel)
  - Role creation & deletion (identifying who created or deleted the role)
  - Voice channel transitions (detecting who moved or disconnected the member via Audit Logs)
  - Command execution tracking (captures the full command with subcommands and arguments)
  - Diagnostic verification command (`/testlog`)
- **💰 Economy System**: Coins and balance management (`/balance`, `/daily`, `/work`, and `/coinflip` betting).
- **🛡️ Moderation Tools & Telemetry**: Administrative actions (`/ban`, `/kick`, `/warn`, `/clear`, `/setlog`, `/testlog`), comprehensive member telemetry (`/userinfo`), and per-command role permission gating (`/cmdperm`, `command_roles`).
- **⚙️ Dynamic Module Settings & Per-Guild Framework**: Robust SQLite database management with atomic batch transactions (`SettingsManager.setGuildMany`), dynamic schema registration, and module enable/disable switches.
- **🧪 Comprehensive Test Suite**: 108 unit and integration tests across 15 test suites powered by Vitest.
- **📚 Automated Documentation**: Automatically scans modules and syncs markdown pages with MkDocs (`npm run docs:generate`).

---

## 📂 Project Structure

```text
sugoiBot/
├── main.js                  # Application entry point (starts bot + dashboard concurrently)
├── deploy-commands.js       # Atomic application (/) command registration script
├── package.json             # Scripts and dependencies
├── mkdocs.yml               # MkDocs documentation configuration
├── dashboard/               # Web Management Dashboard
│   ├── server.js            # Express server (OAuth2, guild API, settings endpoints)
│   └── public/              # Frontend assets (index.html, logo, and favicon)
├── handlers/                # Modular autoloaders
│   ├── commandHandler.js    # Slash command loader
│   ├── eventHandler.js      # Discord gateway event loader
│   └── moduleHandler.js     # Top-level module scanner
├── lib/                     # Shared libraries and utilities
│   ├── bot/
│   │   ├── GigaClient.js    # Discord Client with gateway intents & partials
│   │   ├── logger.js        # Console logger
│   │   └── loggingService.js# Centralized audit embed logger
│   ├── classes/
│   │   └── Member.js        # User database model (XP, Currency, Warnings)
│   ├── utils/
│   │   ├── formatters.js    # Text and timestamp formatters
│   │   ├── rankCard.js      # Canvas rank card generator
│   │   └── leaderboardCard.js # Canvas leaderboard card generator
│   ├── database.js          # SQLite database schema (better-sqlite3)
│   └── settings.js          # SettingsManager (global & per-guild storage)
├── modules/                 # Feature modules
│   ├── core/                # Core events (joins, leaves, deletes, avatar changes)
│   ├── general/             # General utility commands (/ping)
│   ├── economy/             # Economy commands (/balance, /daily, /work, /coinflip)
│   ├── moderation/          # Moderation commands (/ban, /kick, /warn, /clear, /testlog)
│   ├── xp/                  # Leveling system (/rank, /leaderboard, text & voice XP)
│   ├── gamerole/            # Rich presence game role assignment (/gamerole)
│   └── voice/               # Temporary voice channels & controls (/voice)
├── scripts/
│   └── generate-docs.js     # Automated MkDocs documentation generator
├── docs/                    # Generated documentation pages
└── tests/                   # Vitest unit and integration test suites
```

---

## 🛠️ Setup & Installation

### Prerequisites
- [Node.js](https://nodejs.org/) (v18, v22, or v24 recommended)
- A Discord Application & Bot Token from the [Discord Developer Portal](https://discord.com/developers/applications)

### Installation
1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file in the project root:
   ```env
   DISCORD_TOKEN=your_discord_bot_token_here
   CLIENT_ID=your_discord_client_id_here
   CLIENT_SECRET=your_discord_client_secret_here
   DASHBOARD_URL=http://localhost:3000
   GUILD_ID=your_test_guild_id_here
   ```

3. Configure OAuth2 Redirect in the Discord Developer Portal:
   - Navigate to **Applications** &rarr; Your App &rarr; **OAuth2** &rarr; **Redirects**.
   - Add: `http://localhost:3000/auth/discord/callback` (or your production URL).
   - Save changes.

4. Toggle Privileged Gateway Intents:
   - Under **Bot** in the Developer Portal, enable:
     - **Server Members Intent** (required for join/leave logs and member tracking)
     - **Message Content Intent** (required for XP message events)
     - **Presence Intent** (required for GameRole presence updates)

5. Discord Role Hierarchy (Required for GameRole):
   - In Discord **Server Settings** &rarr; **Roles**, drag the bot's role **above** member roles in the hierarchy list.
   - Ensure the bot has the **Manage Roles** permission enabled so it can create and assign `PLAYING <Game>` roles.

---

## 🚀 Running the Project

| Command | Action |
| :--- | :--- |
| `npm start` | Launches the Discord bot and the Web Dashboard concurrently (`http://localhost:3000`). |
| `npm test` | Runs the full Vitest test suite across all 15 test suites. |
| `npm run deploy` | Deploys all application slash commands to Discord. |
| `npm run dashboard` | Starts the Express web dashboard standalone. |
| `npm run docs:generate` | Automatically scans modules and rebuilds MkDocs documentation. |

---

## 🐳 Docker Deployment

### Using Docker Compose
1. Ensure your `.env` file is configured in the project root.
2. Launch the container:
   ```bash
   docker compose up -d
   ```
3. Persistent database data is mapped to `./data` on the host machine, and the dashboard is available at `http://localhost:3000`.

### Building the Image Manually
Build for your current architecture:
```bash
docker build -t sugoibot .
docker run -d --name sugoibot --env-file .env -p 3000:3000 -v $(pwd)/data:/app/data sugoibot
```

---

## 🧩 Adding a New Module

To create a new module (e.g. `tickets`):

1. Create a directory: `modules/tickets/`.
2. Add metadata in `modules/tickets/index.js`:
   ```javascript
   export default {
       name: 'Tickets',
       description: 'Support ticket management system.',
       settings: [
           { key: 'ticket_category_id', description: 'Category for open tickets', type: 'string', defaultValue: '' }
       ]
   };
   ```
3. Place slash commands in `modules/tickets/commands/` and event listeners in `modules/tickets/events/`.
4. The bot will automatically detect, register, document, and load the new module on next startup!
