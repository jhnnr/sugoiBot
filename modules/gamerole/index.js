export default {
    name: 'GameRole',
    description: 'Automatically assigns and removes roles based on users playing presence.',
    setupGuide: `
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
The module includes 84 popular games enabled out-of-the-box. Use \`/gamerole list\` to inspect active games or \`/gamerole add <game>\` to add custom titles.
`,
    settings: [
        { key: 'gamerole_enabled', description: 'Enable GameRole automated presence roles', type: 'boolean', defaultValue: true },
        { key: 'gamerole_prefix', description: 'Prefix for generated game roles', type: 'string', defaultValue: 'PLAYING ' },
        { key: 'gamerole_color', description: 'Hex color for created roles', type: 'string', defaultValue: '#ff0000' }
    ]
};
