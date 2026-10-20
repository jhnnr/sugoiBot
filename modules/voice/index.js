export default {
    name: 'Voice',
    description: 'Dynamic Join-to-Create temporary voice rooms with in-chat interactive controls, lock/unlock, user limits, and permissions.',
    settings: [
        { key: 'voice_enabled', description: 'Enable temporary voice channel system in this server', type: 'boolean', defaultValue: true },
        { key: 'voice_default_limit', description: 'Default user limit for created rooms (0 for unlimited)', type: 'number', defaultValue: 0, min: 0, max: 99 },
        { key: 'voice_naming_scheme', description: 'Template for naming temporary voice channels', type: 'string', defaultValue: "{username}'s Room" }
    ]
};
