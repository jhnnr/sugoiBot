# Core Module

Essential bot functions and event handling.

## ⚙️ Configuration Settings

| Key | Description | Type | Default |
| :--- | :--- | :--- | :--- |
| `log_channel_id` | Channel ID for bot logs | `string` | `` |

## ⌨️ Slash Commands

### `/cmdperm`

Configure required roles for executing specific commands (defaults to Everyone).

#### Options

- `set` (Optional): Require a specific role to execute a command.
- `clear` (Optional): Reset a command to its default permissions (Everyone / Default).
- `list` (Optional): List all custom command role permissions in this server.

## 🔔 Registered Events

- **`channelCreate`** (Trigger: `On`)
- **`channelDelete`** (Trigger: `On`)
- **`guildMemberAdd`** (Trigger: `On`)
- **`guildMemberRemove`** (Trigger: `On`)
- **`guildMemberUpdate`** (Trigger: `On`)
- **`interactionCreate`** (Trigger: `On`)
- **`messageDelete`** (Trigger: `On`)
- **`clientReady`** (Trigger: `Once`)
- **`roleCreate`** (Trigger: `On`)
- **`roleDelete`** (Trigger: `On`)
- **`userUpdate`** (Trigger: `On`)

