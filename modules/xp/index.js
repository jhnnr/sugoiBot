export default {
    name: 'XP',
    description: 'Engagement and leveling system.',
    settings: [
        { key: 'xp_enabled', description: 'Enable XP system', type: 'boolean', defaultValue: true },
        { key: 'xp_min', description: 'Min XP per message', type: 'number', defaultValue: 10 },
        { key: 'xp_max', description: 'Max XP per message', type: 'number', defaultValue: 20 },
        { key: 'xp_voice_per_minute', description: 'XP awarded per minute in voice channels', type: 'number', defaultValue: 5 },
        { key: 'role_rewards', description: 'Map of level to role ID rewards (JSON)', type: 'object', defaultValue: {} }
    ]
};
