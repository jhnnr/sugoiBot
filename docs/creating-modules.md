# Creating Modules & Settings

SugoiBot features a plug-and-play modular architecture. Any folder placed inside `modules/` is automatically discovered, registered, documented, and loaded on bot startup.

---

## 📂 Module Directory Structure

Every module lives in its own subdirectory inside `modules/`:

```text
modules/my-module/
├── index.js           # Module metadata, description, and settings schema
├── commands/          # Discord slash commands (SlashCommandBuilder)
│   └── example.js
└── events/            # Discord gateway event listeners (Events enum)
    └── messageCreate.js
```

---

## 📄 Defining `index.js` & Module Settings

The `index.js` file exports a default object defining the module's name, description, and an array of **configurable settings**.

```javascript
export default {
    name: 'AutoResponder',
    description: 'Custom automated message triggers and responses.',
    settings: [
        { 
            key: 'autoresponder_enabled', 
            description: 'Enable automated responses in this server', 
            type: 'boolean', 
            defaultValue: true 
        },
        { 
            key: 'autoresponder_cooldown', 
            description: 'Cooldown in seconds between triggers', 
            type: 'number', 
            defaultValue: 10,
            min: 1,
            max: 300
        },
        { 
            key: 'autoresponder_prefix', 
            description: 'Prefix for trigger commands', 
            type: 'string', 
            defaultValue: '!' 
        },
        { 
            key: 'autoresponder_log_channel', 
            description: 'Channel where autoresponder logs are sent', 
            type: 'channel', 
            defaultValue: '' 
        },
        { 
            key: 'autoresponder_custom_triggers', 
            description: 'JSON map of trigger phrases to response text', 
            type: 'object', 
            defaultValue: {} 
        }
    ]
};
```

### Supported Setting Schema Types

| Type | Description | Validation | Example Use Cases |
| :--- | :--- | :--- | :--- |
| **`boolean`** | True/False toggle | `typeof value === 'boolean'` | Feature enables, sub-module switches |
| **`number`** | Numeric integer or float | Verified number; supports optional `min` and `max` bounds | Cooldowns, multipliers, XP limits, thresholds |
| **`string`** | Text string | `typeof value === 'string'` | Message templates, prefixes, hex colors |
| **`channel`** | Discord channel snowflake ID | `typeof value === 'string'` (resolves dropdown in dashboard) | Log destinations, announcement channels |
| **`object`** | Structured JSON object / dictionary | `typeof value === 'object'` | Role reward mappings, trigger lists |

---

## ⚙️ Using `SettingsManager` in Your Code

Import `SettingsManager` from `lib/settings.js` to read and write per-guild settings:

### Reading Settings

```javascript
import { SettingsManager } from '../../../lib/settings.js';

// Get parsed setting with type safety and fallback default
const isEnabled = SettingsManager.getGuildJson(guild.id, 'autoresponder_enabled', true);
const cooldown = SettingsManager.getGuildJson(guild.id, 'autoresponder_cooldown', 10);
const triggers = SettingsManager.getGuildJson(guild.id, 'autoresponder_custom_triggers', {});

// Get raw string (useful for channel IDs and templates)
const channelId = SettingsManager.getGuild(guild.id, 'autoresponder_log_channel');
```

### Saving Settings

```javascript
// Validate and store setting for a specific guild
SettingsManager.setGuildJson(guild.id, 'autoresponder_cooldown', 15);

// Batch save multiple settings in a single atomic transaction
SettingsManager.setGuildMany(guild.id, {
    autoresponder_enabled: true,
    autoresponder_cooldown: 20
});
```

---

## 🛡️ Automatic Module Toggles & Gating

Every module is automatically assigned an enable/disable switch per guild: `module_<modulename>_enabled` (e.g. `module_autoresponder_enabled`).

### In Slash Commands
Command execution automatically checks if the command's module is enabled before executing. If disabled by the server admin, the bot replies with an ephemeral notice without running your command:
```text
The AutoResponder module is currently disabled in this server.
```

### In Event Listeners
Inside event listeners, check the guild toggle before performing actions:

```javascript
import { Events } from 'discord.js';
import { SettingsManager } from '../../../lib/settings.js';

export default {
    name: Events.MessageCreate,
    async execute(message) {
        if (message.author.bot || !message.guild) return;

        // Check if module is enabled in this server
        const isModuleEnabled = SettingsManager.getGuildJson(message.guild.id, 'module_autoresponder_enabled', true);
        if (!isModuleEnabled) return;

        // Your custom module logic here...
    }
};
```

---

## ⌨️ Creating Slash Commands

Place command files in `modules/<my-module>/commands/`:

```javascript
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { SettingsManager } from '../../../lib/settings.js';

export default {
    data: new SlashCommandBuilder()
        .setName('trigger')
        .setDescription('Test the autoresponder trigger')
        .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages),
    async execute(interaction) {
        const cooldown = SettingsManager.getGuildJson(interaction.guild.id, 'autoresponder_cooldown', 10);
        await interaction.reply(`Trigger executed! Current server cooldown is ${cooldown}s.`);
    }
};
```

---

## 🔔 Creating Event Listeners

Place event listeners in `modules/<my-module>/events/`:

```javascript
import { Events } from 'discord.js';

export default {
    name: Events.MessageCreate,
    async execute(message) {
        if (message.author.bot || !message.guild) return;
        // Event logic...
    }
};
```

---

## 🌐 Web Dashboard Integration

When you add settings to `index.js`, the web dashboard automatically detects them:
1. **Dynamic Module Discovery**: The backend serves `GET /api/modules`, including your module name, description, and setting definitions.
2. **Toggle Switch**: A checkbox for your module is displayed under **Active Modules** on the server management page.
3. **Settings Modal (`⚙️ Settings`)**: Modules with configurable options receive a dedicated settings prompt modal where administrators can adjust values with live unsaved-changes tracking.

---

## 📚 Automated Documentation

After adding your module, rebuild the documentation suite:

```bash
npm run docs:generate
```

This scans your module's `index.js`, slash commands, and events, generates a detailed markdown page at `docs/modules/<my-module>.md`, and updates `mkdocs.yml` navigation.
