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
- [x] SQLite Database Integration.
- [x] Basic XP Module with `/rank` and `/leaderboard`.
- [x] Economy Module with `/balance`, `/daily`, `/work`, and `/coinflip`.
- [x] Moderation Module with `/ban`, `/kick`, `/clear`, and `/warn`.
- [x] GameRole Module with `/gamerole` and automated `presenceUpdate` role assignment.
- [x] VoiceMaster Module with `/voice setup`, dynamic Join-to-Create temporary voice rooms, and interactive control interface.
- [x] Settings Management Framework and Dashboard UI.
- [x] Automated Module Documentation Generator (`scripts/generate-docs.js`).
- [x] Comprehensive Test Suite (82 unit tests across 15 test suites).
