# GameRole Module

Automatically assigns and removes roles based on users playing presence.

## ⚙️ Configuration Settings

| Key | Description | Type | Default |
| :--- | :--- | :--- | :--- |
| `gamerole_enabled` | Enable GameRole automated presence roles | `boolean` | `true` |
| `gamerole_prefix` | Prefix for generated game roles | `string` | `PLAYING ` |
| `gamerole_color` | Hex color for created roles | `string` | `#ff0000` |

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

