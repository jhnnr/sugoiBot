# GameRole Module

Automatically assigns and removes roles based on users playing presence.

## 📋 Setup & Prerequisites

### 1. Enable Privileged Presence Intent
In the [Discord Developer Portal](https://discord.com/developers/applications):
1. Select your Application &rarr; **Bot**.
2. Scroll to **Privileged Gateway Intents**.
3. Toggle **Presence Intent** to **ON**.
4. Click **Save Changes**.

### 2. Configure Role Permissions & Hierarchy
In your Discord server:
1. Open **Server Settings** &rarr; **Roles**.
2. Make sure the bot's role has the **Manage Roles** permission enabled.
3. **Important**: Drag the bot's role **above** standard member roles in the role hierarchy. Discord strictly prevents bots from creating or assigning roles positioned above their own highest role.

### 3. Built-in Whitelist
The module includes 84 popular games enabled out-of-the-box. Use `/gamerole list` to inspect active games or `/gamerole add <game>` to add custom titles.

## ⚙️ Configuration Settings

| Key | Description | Type | Default |
| :--- | :--- | :--- | :--- |
| `gamerole_enabled` | Enable GameRole automated presence roles | `boolean` | `true` |
| `gamerole_prefix` | Prefix for generated game roles | `string` | `PLAYING ` |
| `gamerole_color` | Hex color for created roles | `string` | `#ff0000` |
| `gamerole_position` | Hierarchy position index for created roles (0 = directly below bot) | `number` | `0` |

## ⌨️ Slash Commands

### `/gamerole`

Manage the GameRole game whitelist and presence role automation.

#### Options

- `add` (Optional): Add a game to the GameRole whitelist.
- `addmygame` (Optional): Add the game you are currently playing to the whitelist.
- `remove` (Optional): Remove or disable a game from the GameRole whitelist.
- `reset` (Optional): Reset whitelist overrides back to the 84 default games.
- `list` (Optional): List all whitelisted games for this server.
- `info` (Optional): Display GameRole module information and status.

## 🔔 Registered Events

- **`presenceUpdate`** (Trigger: `On`)

