export default {
    name: 'XP',
    description: 'Engagement and leveling system.',
    settings: [
        { key: 'xp_enabled', description: 'Enable XP system in this server', type: 'boolean', defaultValue: true },
        { key: 'xp_min', description: 'Min XP awarded per message', type: 'number', defaultValue: 10, min: 1, max: 100 },
        { key: 'xp_max', description: 'Max XP awarded per message', type: 'number', defaultValue: 20, min: 1, max: 100 },
        { key: 'xp_voice_per_minute', description: 'XP awarded per minute in voice channels', type: 'number', defaultValue: 5, min: 0, max: 50 },
        { key: 'xp_channel_id', description: 'Channel for Level Up announcements', type: 'channel', defaultValue: '' },
        { key: 'role_rewards', description: 'Map of level to role ID rewards (JSON)', type: 'object', defaultValue: {} }
    ]
};
