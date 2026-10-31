# Project TODOs

## 🔴 High Priority
- [ ] **Automated SQLite Database Backups**: Scheduled periodic database snapshots and compressed backup exports for disaster recovery.
- [ ] **API Rate Limiting Middleware**: Implement express rate-limiting middleware on auth and API endpoints to prevent request flooding.
- [x] **Error Handling**: Implement a more robust global error handler to prevent bot crashes on unhandled rejections.
- [x] **Cooldowns**: Add a cooldown system to commands to prevent spamming.
- [x] **Validation**: Add validation for settings (e.g., ensure `xp_min` is a number and within bounds).
- [x] **Dynamic Guild Settings**: Migrate single-row settings to per-guild configuration schema (`guild_settings`).

## 🟡 Medium Priority
- [ ] **Voice Hub Creator on Dashboard**: Allow server administrators to create new Join-to-Create voice hubs directly from the web dashboard.
- [ ] **Moderation Warnings Web Viewer**: Add a server moderation interface on the dashboard to inspect, paginate, and revoke member warnings.
- [ ] **Economy Server Shop & Inventory**: Allow administrators to configure server shop items and roles purchasable with economy currency.
- [ ] **Custom Module Embed Colors**: Allow per-guild customization of bot embed accent colors directly from the dashboard.
- [x] **Command Role Permissions & Subcommand Cascading**: Role-based permissions per module, searchable role comboboxes, and automatic parent-to-subcommand role cascading.
- [ ] **Ability to select multiple roles in Command Role Permissions**
- [x] **User Info Command**: User telemetry inspection command (`/userinfo`) displaying account age, join date, inviter, roles, permissions, level, rank, economy, and activity.
- [x] **Moderation Module**: Implement basic moderation commands (`kick`, `ban`, `clear`, `warn`).
- [x] **Economy Module**: Add a basic currency system (balance, daily, work, coinflip).
- [x] **Logging Service**: Implement a dedicated logging channel for bot events (guild join, command usage).
- [x] **Member Classes**: Create a `Member` class in `lib/classes` to abstract database calls for user data.
- [x] **Member Join & Invite Tracking**: Log new member joins with the inviter, invite code, and account age.
- [x] **GameRole Module Settings**: Add server settings for the GameRole module (customizable role prefix, role color, and whitelist toggle).
- [x] **Auto-Generated Module Settings Buttons**: If SettingsManager is used in a module, automatically render a settings button on the dashboard for that module.
- [x] **Role Rewards Management Command**: Add an in-Discord slash command (`/setreward`) and dashboard XP modal integration to configure level role rewards.

## 🟢 Low Priority
- [ ] **Export & Import Server Settings**: Allow server administrators to export and restore their complete configuration as a JSON file.
- [ ] **Server Audit Log Web Viewer**: Stream recent server audit logs directly within the management dashboard.
- [x] **Web Dashboard**: Create an Express.js backend to serve a settings dashboard with live configuration editing.
- [x] **MkDocs Integration**: Set up an automated documentation generator (`npm run docs:generate`) based on module metadata.
- [x] **Unit Tests**: Add Vitest for testing core logic (`settings`, `handlers`, `dashboard`, `formatters`, `member`).
- [x] **Advanced XP**: Implement voice channel XP (`GuildVoiceStates`), level-up notifications, and `/leaderboard` rankings.
- [x] **OAuth2 Dashboard Authentication**: Add Discord login to restrict dashboard access to bot administrators, server selector, and per-server logging toggles.

## ✅ Completed
- [x] Initial Node.js Rewrite (ESM).
- [x] Modular Architecture (Plug-and-play).
- [x] Split Handlers (Module, Command, Event).
- [x] SQLite Database Integration with transaction support (`SettingsManager.setGuildMany`).
- [x] Basic XP Module with `/rank`, `/leaderboard`, and `/setreward` role rewards.
- [x] Economy Module with `/balance`, `/daily`, `/work`, and `/coinflip`.
- [x] Moderation Module with `/ban`, `/kick`, `/clear`, `/warn`, `/testlog`, and `/setlog`.
- [x] GameRole Module with `/gamerole` and automated `presenceUpdate` role assignment (84 built-in games, customizable hierarchy position index, and automatic bottom stacking of PLAYING roles).
- [x] Temporary Voice Module with `/voice setup`, dynamic Join-to-Create hubs, in-chat interactive controls, multi-hub support, and cross-server name persistence.
- [x] Dynamic Module Settings Engine with automated schema registration, validation, and per-module settings retrieval (`SettingsManager.getModuleSettings`).
- [x] Centralized Server Audit Logging (invites, leaves, avatar changes, message deletes, channel create/delete, role create/delete, voice moves with mover detection, command execution).
- [x] Modular Per-Command Role Permissions (individual command and subcommand role gating in `interactionCreate.js`, `/cmdperm`, per-module searchable role comboboxes, parent-to-subcommand role cascading).
- [x] User Info Command (`/userinfo` with full telemetry: account age, server join date, inviter, roles, permissions, XP level/rank, economy balance, warnings, presence).
- [x] In-App Confirmation Modal & Background Scroll Locking (`#confirmModal`, Promise-based `showConfirmModal`, `document.body.style.overflow = 'hidden'`).
- [x] Settings Management Framework and Web Dashboard UI with Discord OAuth2 login, searchable channel comboboxes, modular settings prompts, and floating sticky unsaved-changes save bar.
- [x] Multi-Architecture Docker Containerization & Docker Compose (`linux/amd64`, `linux/arm64`).
- [x] GitHub Actions CI/CD Pipeline (automated Vitest tests and Docker Hub multi-arch publishing with dynamic package.json version tagging).
- [x] Automated Module Documentation Generator (`scripts/generate-docs.js`).
- [x] Comprehensive Test Suite (108 unit tests across 15 test suites).
