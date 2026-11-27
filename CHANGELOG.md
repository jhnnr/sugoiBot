# Changelog

All notable changes to **SugoiBot** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Each stable release (`vX.Y.Z`) automatically extracts and publishes its matching version section from this file as the GitHub Release changelog.

## [v1.4.0] - 2026-11-27

### Added
- Added Economy Server Shop and Inventory system with `/shop` (`list`, `buy`) and `/inventory` slash commands, `shop_items` and `user_inventory` SQLite tables, dashboard CRUD endpoints (`/api/guilds/:guildId/shop`), and JSON settings export/import support.
- Added Dashboard Voice Hub Creator (`POST /api/guilds/:guildId/voice/hubs`) to create Join-to-Create voice hubs in existing or newly created Discord categories directly from the web dashboard.
- Added Moderation Warnings Web Viewer (`GET /api/guilds/:guildId/warnings` and `DELETE /api/guilds/:guildId/warnings/:warningId`) with search, pagination, member/moderator username enrichment, and warning revocation.
- Added per-guild Custom Module Embed Colors (`module_embed_colors` and `SettingsManager.getEmbedColor`) with dashboard hex accent color controls across bot modules.
- Added multi-role Command Role Permissions (`string[]` support via `SettingsManager.normalizeCommandRoles`) across `/cmdperm` (`set`, `add`, `remove`, `clear`, `list`), `interactionCreate` enforcement, and dashboard multi-role chip comboboxes.
- Added Automated SQLite Database Backups (`lib/backupService.js`) with hot `db.backup()` compressed `.sqlite.gz` snapshots, scheduled background backups with retention pruning, disaster-recovery endpoints (`/api/backups`, `/api/backups/export`, `/api/backups/:filename/download`, `/api/backups/:filename`), and dashboard `Backup DB` (`#exportDbBackupBtn`) export control.
- Added API Rate Limiting Middleware (`lib/middleware/rateLimiter.js`) protecting `/auth`, `/api/auth`, and `/api` routes with `RateLimit-*` and `Retry-After` response headers.
- Added live Server-Sent Events (SSE) voice status streaming (`GET /api/guilds/:guildId/voice/stream`) and `voiceHelper` pub/sub (`emitVoiceUpdate`, `subscribeVoiceUpdates`, `channelUpdate`) for real-time `Active Temporary Rooms` and hub updates in the dashboard.
- Added `CHANGELOG.md` release history and `scripts/release-version.js` CI version evaluation and `--extract-notes` automation with `dev` branch workflow and rolling `:dev` Docker tag support.

### Changed
- Redesigned the web management dashboard with an enterprise SaaS workspace layout, summary metrics strip, and expandable `Modules` sidebar dropdown with dedicated inline per-module settings workspaces.
- Consolidated Audit Log channel routing, core embed accent, and event subscription toggles into the dedicated `Audit Logs` dashboard workspace.

### Fixed
- Fixed stale temporary voice room tracking by automatically pruning orphaned, manually deleted, and empty abandoned rooms from `voice_channels` and `voicemaster_channels` (and deleted hubs from `voice_hubs`, `voice_guilds`, and `voicemaster_guilds`) across `channelDelete`, `ClientReady` startup reconciliation, `voiceStateUpdate`, `/voice info`, and `getGuildVoiceSnapshot()` ([#2](https://github.com/jhnnr/sugoiBot/issues/2)).

## [v1.3.3] - 2026-11-18

### Fixed
- Resolved Discord user (`<@id>`, `<@!id>`), channel (`<#id>`), and role (`<@&id>`) mentions to human-readable `@username`, `#channel`, and `@role` names in `loggingService` and dashboard audit log endpoints (with client-side fallback lookup) while preserving native mentions in Discord channel embeds.
- Stripped inline emoji characters across audit log titles and descriptions in the web dashboard and rendered HTML-escaped `**bold**` and `` `code` `` Markdown formatting cleanly instead of raw syntax characters.

## [v1.3.2] - 2026-11-18

### Fixed
- Prevented false-positive `#floatingSaveBar` unsaved-changes prompts when opening module settings modals or clicking role and channel comboboxes without modifying values.
- Guarded combobox outside-click listeners to open dropdowns only, cleaned up stale document click listeners on re-render, and kept `originalFormState` synchronized across asynchronous modal and command loads when unmodified.

## [v1.3.1] - 2026-11-18

### Added
- Added JSON server settings export and import endpoints (`/api/guilds/:guildId/settings/export` and `/import`) with dashboard controls and confirmation modal.
- Added SQLite `audit_logs` persistence (`idx_audit_logs_guild_time`, 250-entry per-guild retention), real-time `loggingService.subscribe()` pub/sub, and a live Server-Sent Events (SSE) Server Audit Logs viewer in the web dashboard with event filtering and search.
- Added GitHub issue templates for bug reports and feature requests (`.github/ISSUE_TEMPLATE/`).
- Added `CLAUDE.md` consolidating agent behavioral rules and accumulated project learnings alongside open-standard `AGENTS.md` documentation.

### Changed
- Updated `SettingsManager.validate(key, value, context)` to validate cross-field `xp_min`/`xp_max` and `work_min`/`work_max` bounds against incoming batch `context` values before falling back to persisted database values.

### Fixed
- Fixed `/api/stats` active guild count calculation by intersecting live bot guild membership (`discordClient.guilds.cache` with Discord REST fallback) against the authenticated user's manageable guilds.
- Stripped stray literal quotes from channel snowflake IDs during `SettingsManager.setGuildMany` batch updates.

## [v1.3.0] - 2026-10-31

### Added
- Added `/cmdperm` slash command (`set`, `clear`, `list`) and dashboard Command Role Permissions UI with parent-to-subcommand role cascading to restrict individual commands by role.
- Added `/userinfo` slash command displaying member profile details, roles, join telemetry, and invite attribution.
- Added `member_invites` SQLite table and invite tracking on `guildMemberAdd` to record inviter attribution.
- Added command discovery API endpoint on the dashboard to list commands and subcommands across all loaded modules.

### Changed
- Updated `interactionCreate` to enforce per-command `command_roles` restrictions while allowing Administrators and server owners to bypass role checks.

## [v1.2.0] - 2026-10-24

### Added
- Added `roleCreate` and `roleDelete` audit logging events (`log_events_roles`) with Discord Audit Log executor lookup and dashboard toggle controls.
- Added `gamerole_position` setting to the GameRole module and automatic role hierarchy placement positioning newly created game roles directly below existing `PLAYING` roles (clamped below the bot's highest role).

## [v1.1.4] - 2026-10-24

### Changed
- Passed the live `GigaClient` instance into `startDashboard(client)` so guild channels, roles, and voice hubs resolve directly from the in-memory Discord.js cache before falling back to the Discord REST API.
- Streamlined voice XP level-up announcement wording in `voiceStateUpdate`.

### Fixed
- Sanitized `DISCORD_TOKEN` whitespace and surrounding quotes when falling back to Discord REST API lookups in the web dashboard.

## [v1.1.3] - 2026-10-22

### Added
- Added continuous 60-second background voice XP accumulation (`xp_voice_per_minute`) with startup registration of members already connected to voice channels.

### Changed
- Partitioned member XP and level progression strictly per guild in SQLite using a composite `(guildId, userId)` primary key across `Member`, `/rank`, and `/leaderboard`.

## [v1.1.2] - 2026-10-22

### Added
- Added refresh controls and asynchronous data loading for Level Role Rewards and Voice Hubs sections in the web dashboard.

### Fixed
- Excluded auxiliary search and picker inputs from form dirty-state snapshots and added an `isSwitchingGuild` transition guard to prevent false-positive save bar prompts when switching servers.

## [v1.1.1] - 2026-10-22

### Added
- Added unsaved-changes tracking with Save Changes and Reset controls in web dashboard module configuration modals.

## [v1.1.0] - 2026-10-22

### Added
- Added Level Role Rewards system with the `/setreward` slash command, `role_rewards_enabled` toggle, automatic role assignment on message and voice level-ups, and dashboard role reward management APIs.
- Added guild role listing and voice hub deletion endpoints in `dashboard/server.js`.

### Changed
- Updated the Docker CI/CD workflow (`.github/workflows/docker-publish.yml`) to detect `package.json` version changes, skip duplicate tag builds, and automatically create `vX.Y.Z` GitHub Releases.

### Fixed
- Hardened Discord OAuth2 session handling in the dashboard to validate `session.guilds` as an array when upstream API requests fail.

## [v1.0.3] - 2026-10-21

### Changed
- Refined `userUpdate` and `guildMemberUpdate` avatar change audit log embeds with cleaner descriptions and standardized timestamp footers.
- Expanded GameRole setup documentation, presence role management, and automated module documentation generation (`scripts/generate-docs.js`).

## [v1.0.2] - 2026-10-21

### Added
- Added `/gamerole reset` subcommand to restore the default 84-game whitelist and enhanced game removal cleanup in the GameRole module.
- Added server icon rendering and refined header layout on Canvas `/leaderboard` cards.

## [v1.0.1] - 2026-10-21

### Added
- Added `/setlog` moderation command to configure the server audit log channel directly within Discord with bot permission verification.
- Added dynamic per-module settings schema registration (`SettingsManager.registerSchema`, `getModuleSettings`), `xp_channel_id` level-up announcement routing, and dynamic module settings modals in the dashboard.

### Fixed
- Isolated guild channel snowflake settings (`log_channel_id`, `xp_channel_id`, `*_channel_id`) in `SettingsManager.getGuild` so channel IDs never fall back across guilds.
- Installed `fontconfig`, `fonts-dejavu-core`, and `fonts-noto-color-emoji` in the runtime `Dockerfile` for reliable Canvas text rendering in Linux containers.

## [v1.0.0] - 2026-10-21

### Added
- Initial modular Discord.js v14 bot architecture (`GigaClient`, dynamic module/command/event autoloaders, `better-sqlite3` persistence, and `SettingsManager`).
- Added Core, General (`/ping`), XP (`/rank`, `/leaderboard` with `@napi-rs/canvas` cards), Economy (`/balance`, `/daily`, `/work`, `/coinflip`), Moderation (`/ban`, `/kick`, `/warn`, `/clear`, `/testlog`), Voice (`/voice` temporary Join-to-Create rooms and integrated room control panel), and GameRole (`/gamerole` automated presence role assignment) modules.
- Added centralized Discord embed audit logging (`loggingService`) covering member joins/leaves, profile updates, message deletions, and channel creation/deletion.
- Added Express v5 web management dashboard with Discord OAuth2 login, per-guild module toggles, and live configuration APIs.
- Added multi-architecture (`linux/amd64`, `linux/arm64`) `Dockerfile`, `docker-compose.yml`, `gosu` `entrypoint.sh` volume permission handling, GitHub Actions Docker Hub publishing workflow, MkDocs documentation generator, and Vitest test suite.

[v1.4.0]: https://github.com/jhnnr/sugoiBot/compare/v1.3.3...v1.4.0
[v1.3.3]: https://github.com/jhnnr/sugoiBot/compare/v1.3.2...v1.3.3
[v1.3.2]: https://github.com/jhnnr/sugoiBot/compare/v1.3.1...v1.3.2
[v1.3.1]: https://github.com/jhnnr/sugoiBot/compare/v1.3.0...v1.3.1
[v1.3.0]: https://github.com/jhnnr/sugoiBot/compare/v1.2.0...v1.3.0
[v1.2.0]: https://github.com/jhnnr/sugoiBot/compare/v1.1.4...v1.2.0
[v1.1.4]: https://github.com/jhnnr/sugoiBot/compare/v1.1.3...v1.1.4
[v1.1.3]: https://github.com/jhnnr/sugoiBot/compare/v1.1.2...v1.1.3
[v1.1.2]: https://github.com/jhnnr/sugoiBot/compare/v1.1.1...v1.1.2
[v1.1.1]: https://github.com/jhnnr/sugoiBot/compare/v1.1.0...v1.1.1
[v1.1.0]: https://github.com/jhnnr/sugoiBot/compare/434a0d1...v1.1.0
[v1.0.3]: https://github.com/jhnnr/sugoiBot/compare/046fb38...434a0d1
[v1.0.2]: https://github.com/jhnnr/sugoiBot/compare/d1f8872...046fb38
[v1.0.1]: https://github.com/jhnnr/sugoiBot/compare/8610a55...d1f8872
[v1.0.0]: https://github.com/jhnnr/sugoiBot/compare/9fdbb85...8610a55
