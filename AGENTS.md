# AGENTS.md

Repository context, commands, architecture, and conventions for AI coding agents, following the [AGENTS.md](https://agents.md) open standard.

For agent behavioral rules, workflow discipline, and accumulated session memory, see `GEMINI.md`.

---

## 1. Project Overview & Stack

**SugoiBot** is a modular Discord bot and Express web management dashboard.

- **Language & Runtime**: `Node.js 18+ / 22 / 24` (`"type": "module"` ESM)
- **Frameworks & Libraries**: `discord.js v14`, `express v5`, `better-sqlite3 v13`, `@napi-rs/canvas v1`, `cookie-parser v1`, `dotenv v16`
- **Testing Framework**: `vitest v4`
- **Package Manager**: `npm`
- **Database**: `SQLite` (`data/database.sqlite` via `better-sqlite3`)

---

## 2. Build, Test, and Development Commands

- **Install dependencies**: `npm install`
- **Run bot and dashboard concurrently**: `npm start` (`node main.js`)
- **Run dashboard standalone**: `npm run dashboard` (`node dashboard/server.js`)
- **Deploy slash commands**: `npm run deploy` (`node deploy-commands.js`)
- **Run full test suite**: `npm test` (`vitest run` — 108 tests across 15 suites)
- **Run a single test file (preferred during iteration)**: `npx vitest run tests/modules.voice.test.js`
- **Generate MkDocs documentation**: `npm run docs:generate` (`node scripts/generate-docs.js`)
- **Run via Docker Compose**: `docker compose up -d`

---

## 3. Project Structure & Layout

- `main.js`: Entry point launching the Express dashboard, loading bot modules, deploying slash commands asynchronously, and logging into Discord.
- `deploy-commands.js`: Atomic slash command registration script.
- `modules/`: Plug-and-play feature modules (`core`, `general`, `economy`, `moderation`, `xp`, `gamerole`, `voice`). Each module contains `index.js` (metadata and settings schema), optional `commands/`, and optional `events/`.
- `handlers/`: Autoloaders for modules, slash commands, and gateway events (`moduleHandler.js`, `commandHandler.js`, `eventHandler.js`).
- `lib/`:
  - `database.js`: SQLite schema initialization and migrations (`settings`, `guild_settings`, `users`, `xp`, `warnings`, `currency`, `gamerole_whitelist`, `member_invites`, `voice_guilds`, `voice_hubs`, `voice_channels`, `voice_user_settings`, `voicemaster_guilds`, `voicemaster_channels`).
  - `settings.js`: `SettingsManager` for global and per-guild configuration, dynamic schema registration (`registerSchema`, `getModuleSettings`), validation, and transactional batch updates (`setGuildMany`).
  - `bot/`: `GigaClient.js` (Discord client with gateway intents and partials), `loggingService.js` (centralized audit embed logger), `logger.js`.
  - `classes/`: `Member.js` (OOP database abstraction for per-guild XP/levels, global currency, and guild warnings).
  - `utils/`: `rankCard.js` (Canvas rank card generator), `leaderboardCard.js` (Canvas leaderboard card generator), `formatters.js`.
- `dashboard/`:
  - `server.js`: Express v5 server handling Discord OAuth2 login, session management, guild discovery, live Discord cache lookups (channels, roles, voice hubs), and per-guild settings APIs.
  - `public/`: Frontend (`index.html`) featuring OAuth landing page, server selector, module toggles, modal settings, command role permission comboboxes, audit log checkboxes, and unsaved-changes bar.
- `Dockerfile`, `docker-compose.yml`, `entrypoint.sh`: Multi-arch containerization (`linux/amd64`, `linux/arm64`) with `gosu` privilege de-escalation for non-root `/app/data` volume permissions.
- `.github/workflows/docker-publish.yml`: CI/CD workflow running Vitest and publishing multi-arch Docker images tagged with the `package.json` version.
- `docs/` & `scripts/generate-docs.js`: MkDocs documentation and automated module reference generator (`docs/modules/*.md`).
- `tests/`: 15 Vitest test suites covering modules, handlers, utilities, database settings, and dashboard endpoints.

---

## 4. Code Style & Repo Conventions

- **ESM Imports**: Always include the `.js` extension in relative imports.
- **Environment Loading**: Always load `.env` using an explicit path relative to the project root (`path.resolve(__dirname, '..', '.env')` or `path.resolve(__dirname, '.env')`) to prevent `process.cwd()` mismatches when launched from subdirectories.
- **Database Directory Resolution**: Resolve the SQLite data directory via `process.env.DATA_DIR || path.resolve(__dirname, '..', 'data')` rather than relying on `process.cwd()`.
- **SQLite Batch Updates**: Use `SettingsManager.setGuildMany(guildId, updates)` with SQLite transactions for batch updates to avoid V8 GC churn on native prepared statements.
- **Channel Snowflake Isolation**: Never allow guild channel snowflake settings (`log_channel_id`, `xp_channel_id`, `*_channel_id`) to fall back to global settings in `SettingsManager.getGuild`.
- **Audit Logging**: In `loggingService.log`, pass `user: <User>` so the embed author header displays the user's avatar and tag, and rely on `embed.setTimestamp()` without redundant footer text.
- **Slash Commands & Module Gating**: Build commands with `SlashCommandBuilder`. `commandHandler.js` attaches `command.module = moduleName`. Per-guild module enablement (`module_<name>_enabled`) and per-command role permissions (`command_roles`) are enforced in `modules/core/events/interactionCreate.js` and module events.
- **Discord.js v14 Roles**: Pass `colors: { primaryColor: hex }` to `RoleManager.create()` instead of the deprecated `color` option.
- **Temporary Voice Rooms**: In `modules/voice/`, send the room control panel directly into the temporary voice channel's integrated text chat upon creation rather than creating separate static text channels. Track hubs by `hubChannelId` (`voice_hubs`) and persist custom room names per user in `voice_user_settings`.
- **Canvas Rendering**: Keep `@napi-rs/canvas` fonts compatible with Linux Docker containers (`fontconfig`, `fonts-dejavu-core`, `GlobalFonts.loadSystemFonts()`, and `"DejaVu Sans", sans-serif` font family stack).

---

## 5. Testing Guidelines

- Run single test files (`npx vitest run tests/<suite>.test.js`) for fast feedback while iterating, and run the full test suite (`npm test`) before finishing a task.
- Every bug fix or validation change should be accompanied by a corresponding unit or integration test in `tests/`.
- Tests mock Discord.js structures or use isolated SQLite state; ensure tests clean up state and do not depend on live external network calls.

---

## 6. Boundaries & Forbidden Actions

- **No Double Command Deployment Calls**: Never make two consecutive `rest.put` calls in `deploy-commands.js` (e.g., clearing with `[]` before uploading); use a single atomic `rest.put` to avoid Discord global rate-limit locks.
- **No Blocking Startup on Deployment**: Do not block `client.login()` or `startDashboard()` behind `deployCommands()`.
- **No ZWJ Composite Emojis in Buttons**: Do not pass multi-codepoint ZWJ emoji sequences (such as `👁️‍🗨️`) to Discord button `setEmoji()`; use standard single-codepoint emojis (`👀`, `👻`, `🔒`).
- **No Quoted Snowflakes**: Do not store channel or role snowflake IDs with literal quotes in SQLite; sanitize strings with `.replace(/^["']|["']$/g, '')`.
- **No Emojis in Dashboard UI**: Never use emojis in the web dashboard (`dashboard/public/index.html`); use clean, minimalist inline SVGs instead.
