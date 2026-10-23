# SugoiBot Documentation

Welcome to the official documentation for **SugoiBot**, a modern, modular Discord bot framework and web management dashboard built with **Node.js (ESM)** and **Discord.js v14**.

---

## 🚀 Core Systems

SugoiBot is designed from the ground up for extensibility, scalability, and performance.

- **🧩 Plug-and-Play Modules**: Every feature is an isolated, self-contained module in `modules/` with its own commands, event listeners, and settings schema.
- **🌐 Web Management Dashboard**: An Express v5 web portal featuring Discord OAuth2 authentication, server selector for administrators, searchable channel comboboxes, and a floating unsaved-changes save bar.
- **🔊 Temporary Voice Rooms**: Dynamic *Join-to-Create* voice hubs that automatically spawn private voice rooms, post an interactive control panel (`🔒 Lock`, `🔓 Unlock`, `👻 Ghost`, `👀 Unhide`, `✏️ Rename`, `👥 Limit`, `👑 Claim`) directly into the room's built-in chat box, and delete the room when empty. Supports multiple concurrent hubs per server and cross-server room name persistence.
- **🎮 GameRole System**: Automatically assigns and removes server roles based on what games members are playing via Discord Rich Presence, with 84 built-in popular games and per-server custom whitelist overrides.
- **🎨 Visual Canvas Cards**: High-performance graphical rank cards (`/rank`) and multi-row server leaderboards (`/leaderboard`) generated dynamically via `@napi-rs/canvas`.
- **📜 Server Audit Logging**: Centralized embed logging with user avatar headers, clean action summaries, and native relative timestamps:
  - Member joins with **invite tracking** (identifying the inviter and code used)
  - Member departures and avatar change auditing (showing previous vs. current avatars)
  - Message deletions (with uncached message support)
  - Channel creation & deletion (identifying who created or deleted the channel)
  - Role creation & deletion (identifying who created or deleted the role)
  - Voice transitions (identifying who moved or disconnected the user via Audit Logs)
  - Command execution tracking (logging the full command with subcommands and options)
  - Diagnostic verification tool (`/testlog`) and in-server channel setup (`/setlog`)
- **💰 Economy System**: Coins and balance management (`/balance`, `/daily`, `/work`, and `/coinflip` betting).
- **🛡️ Server Moderation**: Full administrative toolset (`/ban`, `/kick`, `/warn`, `/clear`, `/setlog`, `/testlog`).
- **⚙️ Per-Guild Settings Engine**: Robust SQLite database management with atomic batch transactions (`SettingsManager.setGuildMany`).

---

## 📦 Built-in Modules

| Module | Description | Documentation |
| :--- | :--- | :--- |
| **Core** | Essential bot functions, event routing, and centralized audit logging | [Core Module Docs](modules/core.md) |
| **General** | Everyday server utilities and status commands (`/ping`) | [General Module Docs](modules/general.md) |
| **Economy** | Currency, daily rewards, work, and `/coinflip` gambling | [Economy Module Docs](modules/economy.md) |
| **Moderation** | Server moderation, logging configuration, and audit verification | [Moderation Module Docs](modules/moderation.md) |
| **XP & Leveling** | Chat & voice engagement leveling, visual rank cards, and leaderboards | [XP Module Docs](modules/xp.md) |
| **GameRole** | Rich Presence game detection and automated role assignment | [GameRole Module Docs](modules/gamerole.md) |
| **Voice** | Temporary voice rooms with in-chat interactive controls | [Voice Module Docs](modules/voice.md) |

---

## 🛠️ Quick Start

For installation, environment configuration (`.env`), Docker setup, and deployment guides, see the [Project README](../README.md).

---

## 📖 Developer Guides

Learn how to build your own custom modules and configure module-specific settings:

- **[Creating Modules & Settings Guide](creating-modules.md)**: Step-by-step instructions on module layout, declaring settings schemas, using `SettingsManager`, and integrating with the web dashboard.
