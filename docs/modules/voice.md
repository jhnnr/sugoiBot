# Voice Module

Dynamic Join-to-Create temporary voice rooms with in-chat interactive controls, lock/unlock, user limits, and permissions.

## ⚙️ Configuration Settings

| Key | Description | Type | Default |
| :--- | :--- | :--- | :--- |
| `voice_enabled` | Enable temporary voice channel system in this server | `boolean` | `true` |
| `voice_default_limit` | Default user limit for created rooms (0 for unlimited) | `number` | `0` |
| `voice_naming_scheme` | Template for naming temporary voice channels | `string` | `{username}'s Room` |

## ⌨️ Slash Commands

### `/voice`

Manage temporary voice rooms and server voice configuration.

#### Options

- `setup` (Optional): Set up the Join-to-Create temporary voice channel system.
- `info` (Optional): View temporary voice system configuration or current room details.
- `lock` (Optional): Lock your voice room to prevent other members from joining.
- `unlock` (Optional): Unlock your voice room to allow public access.
- `name` (Optional): Rename your temporary voice room.
- `limit` (Optional): Set the maximum user limit for your room.
- `claim` (Optional): Claim ownership of this room if the previous host left.
- `permit` (Optional): Allow a specific user to join your locked room.
- `reject` (Optional): Deny a user access to your room and kick them if inside.

## 🔔 Registered Events

- **`interactionCreate`** (Trigger: `On`)
- **`voiceStateUpdate`** (Trigger: `On`)

