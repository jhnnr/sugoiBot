export default {
    name: 'GameRole',
    description: 'Automatically assigns and removes roles based on users playing presence.',
    settings: [
        { key: 'gamerole_enabled', description: 'Enable GameRole automated presence roles', type: 'boolean', defaultValue: true },
        { key: 'gamerole_prefix', description: 'Prefix for generated game roles', type: 'string', defaultValue: 'PLAYING ' },
        { key: 'gamerole_color', description: 'Hex color for created roles', type: 'string', defaultValue: '#ff0000' }
    ]
};
