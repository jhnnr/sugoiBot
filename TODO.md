# Project TODOs

## 🔴 High Priority
- [x] **Error Handling**: Implement a more robust global error handler to prevent bot crashes on unhandled rejections.
- [x] **Cooldowns**: Add a cooldown system to commands to prevent spamming.
- [x] **Validation**: Add validation for settings (e.g., ensure `xp_min` is a number and within bounds).
- [x] **Dynamic Guild Settings**: Migrate single-row settings to per-guild configuration schema (`guild_settings`).

## 🟡 Medium Priority
- [x] **Moderation Module**: Implement basic moderation commands (`kick`, `ban`, `clear`, `warn`).
- [x] **Economy Module**: Add a basic currency system (balance, daily, work, coinflip).
- [x] **Logging Service**: Implement a dedicated logging channel for bot events (guild join, command usage).
- [x] **Member Classes**: Create a `Member` class in `lib/classes` to abstract database calls for user data.
- [x] **Member Join & Invite Tracking**: Log new member joins with the inviter, invite code, and account age.
- [ ] **GameRole Module Settings**: Add server settings for the GameRole module (customizable role prefix, role color, and whitelist toggle).
- [ ] **Auto-Generated Module Settings Buttons**: If SettingsManager is used in a module, automatically render a settings button (`⚙️ Settings`) on the dashboard for that module.
- [ ] **Role Rewards Management Command**: Add an in-Discord slash command (`/setreward`) to configure level role rewards.

## 🟢 Low Priority
- [x] **Web Dashboard**: Create a basic Express.js backend to serve a settings dashboard with live configuration editing.
- [x] **MkDocs Integration**: Set up an automated documentation generator (`npm run docs:generate`) based on module metadata.
- [x] **Unit Tests**: Add Vitest for testing core logic (`settings`, `handlers`, `dashboard`, `formatters`, `member`).
- [x] **Advanced XP**: Implement voice channel XP (`GuildVoiceStates`), level-up notifications, and `/leaderboard` rankings.
- [x] **OAuth2 Dashboard Authentication**: Add Discord login to restrict dashboard access to bot administrators, server selector, and per-server logging toggles.

## ✅ Completed
- [x] Initial Node.js Rewrite (ESM).
- [x] Modular Architecture (Plug-and-play).
- [x] Split Handlers (Module, Command, Event).
- [x] SQLite Database Integration with transaction support (`SettingsManager.setGuildMany`).
- [x] Basic XP Module with `/rank` and `/leaderboard` (Canvas card generation via `@napi-rs/canvas`).
- [x] Economy Module with `/balance`, `/daily`, `/work`, and `/coinflip`.
- [x] Moderation Module with `/ban`, `/kick`, `/clear`, `/warn`, `/testlog`, and `/setlog`.
- [x] GameRole Module with `/gamerole` and automated `presenceUpdate` role assignment (84 built-in games).
- [x] Temporary Voice Module with `/voice setup`, dynamic Join-to-Create hubs, in-chat interactive controls, multi-hub support, and cross-server name persistence.
- [x] Dynamic Module Settings Engine with automated schema registration, validation, and per-module settings retrieval (`SettingsManager.getModuleSettings`).
- [x] Centralized Server Audit Logging (invites, leaves, avatar changes, message deletes, channel create/delete, voice moves with mover detection, command execution).
- [x] Settings Management Framework and Web Dashboard UI with Discord OAuth2 login, searchable channel comboboxes, modular settings prompts (`⚙️ Settings`), and floating sticky unsaved-changes save bar.
- [x] Multi-Architecture Docker Containerization & Docker Compose (`linux/amd64`, `linux/arm64`).
- [x] GitHub Actions CI/CD Pipeline (automated Vitest tests and Docker Hub multi-arch publishing with dynamic package.json version tagging).
- [x] Automated Module Documentation Generator (`scripts/generate-docs.js`).
- [x] Comprehensive Test Suite (90 unit tests across 15 test suites).
