# XP Module

Engagement and leveling system.

## ⚙️ Configuration Settings

| Key | Description | Type | Default |
| :--- | :--- | :--- | :--- |
| `xp_enabled` | Enable XP system | `boolean` | `true` |
| `xp_min` | Min XP per message | `number` | `10` |
| `xp_max` | Max XP per message | `number` | `20` |
| `xp_voice_per_minute` | XP awarded per minute in voice channels | `number` | `5` |
| `role_rewards` | Map of level to role ID rewards (JSON) | `object` | `{}` |

## ⌨️ Slash Commands

### `/leaderboard`

Shows the top ranked members by level and XP.

#### Options

- `limit` (Optional): Number of top members to display (1-10)

### `/rank`

Check your rank

#### Options

- `user` (Optional): User to check

## 🔔 Registered Events

- **`messageCreate`** (Trigger: `On`)
- **`voiceStateUpdate`** (Trigger: `On`)

