import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsManager, DEFAULT_MODULE_EMBED_COLORS } from '../lib/settings.js';
import db from '../lib/database.js';

vi.mock('../lib/database.js', () => ({
    default: {
        prepare: vi.fn()
    }
}));

describe('SettingsManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('get should return null if key not found', () => {
        db.prepare.mockReturnValue({
            get: vi.fn().mockReturnValue(undefined)
        });

        expect(SettingsManager.get('nonexistent')).toBeNull();
    });

    it('get should return value if key found', () => {
        db.prepare.mockReturnValue({
            get: vi.fn().mockReturnValue({ value: 'somevalue' })
        });

        expect(SettingsManager.get('existent')).toBe('somevalue');
    });

    it('set should call db prepare and run', () => {
        const mockRun = vi.fn();
        db.prepare.mockReturnValue({
            run: mockRun
        });

        SettingsManager.set('key', 'value');
        expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT OR REPLACE INTO settings'));
        expect(mockRun).toHaveBeenCalledWith('key', 'value');
    });

    it('getJson should return default value if key not found', () => {
        db.prepare.mockReturnValue({
            get: vi.fn().mockReturnValue(undefined)
        });

        expect(SettingsManager.getJson('key', { def: 1 })).toEqual({ def: 1 });
    });

    it('getJson should return parsed json if key found', () => {
        db.prepare.mockReturnValue({
            get: vi.fn().mockReturnValue({ value: JSON.stringify({ a: 1 }) })
        });

        expect(SettingsManager.getJson('key', {})).toEqual({ a: 1 });
    });

    it('validate should correctly validate xp_min and xp_max', () => {
        // Mock getJson for xp_max when validating xp_min
        const mockGet = vi.fn()
            .mockReturnValueOnce({ value: '20' }) // for max when checking min
            .mockReturnValueOnce({ value: '10' }); // for min when checking max

        db.prepare.mockReturnValue({
            get: mockGet
        });

        expect(SettingsManager.validate('xp_min', 5)).toBe(true);
        expect(SettingsManager.validate('xp_min', 25)).toBe(false);
        expect(SettingsManager.validate('xp_max', 30)).toBe(true);
        expect(SettingsManager.validate('xp_max', 5)).toBe(false);
    });

    it('getAll should return all parsed settings from db', () => {
        db.prepare.mockReturnValue({
            all: vi.fn().mockReturnValue([
                { key: 'xp_min', value: '15' },
                { key: 'xp_enabled', value: 'true' },
                { key: 'raw_key', value: 'unparsed' }
            ])
        });

        const all = SettingsManager.getAll();
        expect(all).toEqual({
            xp_min: 15,
            xp_enabled: true,
            raw_key: 'unparsed'
        });
    });

    it('validate should validate boolean and numeric fields', () => {
        expect(SettingsManager.validate('xp_enabled', true)).toBe(true);
        expect(SettingsManager.validate('xp_enabled', 'not-a-bool')).toBe(false);
        expect(SettingsManager.validate('log_events_member_join', true)).toBe(true);
        expect(SettingsManager.validate('log_events_member_join', 'false')).toBe(false);
        expect(SettingsManager.validate('module_economy_enabled', true)).toBe(true);
        expect(SettingsManager.validate('module_economy_enabled', 'invalid')).toBe(false);

        expect(SettingsManager.validate('xp_voice_per_minute', 10)).toBe(true);
        expect(SettingsManager.validate('xp_voice_per_minute', -5)).toBe(false);

        expect(SettingsManager.validate('daily_amount', 200)).toBe(true);
        expect(SettingsManager.validate('daily_amount', 'abc')).toBe(false);
    });

    it('registerSchema and getSchema should register and dynamically validate custom module settings', () => {
        SettingsManager.registerSchema([
            { key: 'custom_limit', type: 'number', min: 1, max: 50 },
            { key: 'custom_enabled', type: 'boolean' },
            { key: 'custom_channel', type: 'channel' }
        ]);

        expect(SettingsManager.getSchema('custom_limit')).toEqual(expect.objectContaining({ type: 'number' }));
        expect(SettingsManager.validate('custom_limit', 25)).toBe(true);
        expect(SettingsManager.validate('custom_limit', 100)).toBe(false);
        expect(SettingsManager.validate('custom_limit', -5)).toBe(false);
        expect(SettingsManager.validate('custom_limit', 'not-a-number')).toBe(false);

        expect(SettingsManager.validate('custom_enabled', true)).toBe(true);
        expect(SettingsManager.validate('custom_enabled', 'true')).toBe(false);

        expect(SettingsManager.validate('custom_channel', '123456789')).toBe(true);
        expect(SettingsManager.validate('custom_channel', 123456789)).toBe(false);
    });

    it('getModuleSchemas and getModuleSettings should retrieve all module settings for a guild', () => {
        SettingsManager.registerSchema([
            { key: 'xp_min', type: 'number', defaultValue: 10 },
            { key: 'xp_max', type: 'number', defaultValue: 20 },
            { key: 'xp_voice_per_minute', type: 'number', defaultValue: 5 }
        ], 'xp');

        const xpSchemas = SettingsManager.getModuleSchemas('xp');
        expect(xpSchemas.length).toBeGreaterThanOrEqual(3);

        db.prepare.mockReturnValue({
            get: vi.fn().mockImplementation((guildId, key) => {
                if (key === 'xp_min') return { value: '15' };
                return null;
            })
        });

        const guildXp = SettingsManager.getModuleSettings('guild_test_1', 'xp');
        expect(guildXp.xp_min).toBe(15);
        expect(guildXp.xp_max).toBe(20);
    });

    it('getGuild should fetch from guild_settings and strictly isolate log_channel_id', () => {
        // Guild specific found
        db.prepare.mockReturnValueOnce({
            get: vi.fn().mockReturnValue({ value: 'custom_log' })
        });
        expect(SettingsManager.getGuild('guild123', 'log_channel_id')).toBe('custom_log');

        // Guild specific not found for log_channel_id: returns null without global fallback
        db.prepare.mockReturnValueOnce({
            get: vi.fn().mockReturnValue(undefined)
        });
        expect(SettingsManager.getGuild('guild123', 'log_channel_id')).toBeNull();

        // General non-channel key: falls back to global
        db.prepare.mockReturnValueOnce({
            get: vi.fn().mockReturnValue(undefined)
        }).mockReturnValueOnce({
            get: vi.fn().mockReturnValue({ value: 'global_val' })
        });
        expect(SettingsManager.getGuild('guild123', 'custom_prefix')).toBe('global_val');
    });

    it('setGuild should store into guild_settings table', () => {
        const mockRun = vi.fn();
        db.prepare.mockReturnValue({
            run: mockRun
        });

        SettingsManager.setGuild('guild123', 'log_channel_id', 'ch999');
        expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT OR REPLACE INTO guild_settings'));
        expect(mockRun).toHaveBeenCalledWith('guild123', 'log_channel_id', 'ch999');
    });

    it('getAllGuild should return parsed guild settings', () => {
        db.prepare.mockReturnValue({
            all: vi.fn().mockReturnValue([
                { key: 'log_channel_id', value: '"ch123"' },
                { key: 'log_events_member_join', value: 'true' }
            ])
        });

        const res = SettingsManager.getAllGuild('guild123');
        expect(res).toEqual({
            log_channel_id: 'ch123',
            log_events_member_join: true
        });
    });

    it('validate should use batch context for cross-field xp_min/xp_max and work_min/work_max validation', () => {
        const batchValid = { xp_min: 25, xp_max: 50, work_min: 60, work_max: 120 };
        expect(SettingsManager.validate('xp_min', 25, batchValid)).toBe(true);
        expect(SettingsManager.validate('xp_max', 50, batchValid)).toBe(true);
        expect(SettingsManager.validate('work_min', 60, batchValid)).toBe(true);
        expect(SettingsManager.validate('work_max', 120, batchValid)).toBe(true);

        const batchInvalid = { xp_min: 60, xp_max: 40, work_min: 100, work_max: 50 };
        expect(SettingsManager.validate('xp_min', 60, batchInvalid)).toBe(false);
        expect(SettingsManager.validate('xp_max', 40, batchInvalid)).toBe(false);
        expect(SettingsManager.validate('work_min', 100, batchInvalid)).toBe(false);
        expect(SettingsManager.validate('work_max', 50, batchInvalid)).toBe(false);
    });

    it('setGuildMany should sanitize channel snowflakes and validate batch ranges with context', () => {
        const mockRun = vi.fn();
        db.prepare.mockReturnValue({ run: mockRun });
        db.transaction = vi.fn((fn) => (items) => fn(items));

        SettingsManager.setGuildMany('guild_batch_1', {
            log_channel_id: '"123456789012345678"',
            xp_channel_id: "'987654321098765432'",
            xp_min: 30,
            xp_max: 60
        });

        expect(mockRun).toHaveBeenCalledWith('guild_batch_1', 'log_channel_id', JSON.stringify('123456789012345678'));
        expect(mockRun).toHaveBeenCalledWith('guild_batch_1', 'xp_channel_id', JSON.stringify('987654321098765432'));
        expect(mockRun).toHaveBeenCalledWith('guild_batch_1', 'xp_min', JSON.stringify(30));
        expect(mockRun).toHaveBeenCalledWith('guild_batch_1', 'xp_max', JSON.stringify(60));
    });

    it('validate should accept valid module_embed_colors maps and reject invalid hex or non-plain objects', () => {
        expect(DEFAULT_MODULE_EMBED_COLORS).toEqual(expect.objectContaining({
            core: '#5865F2',
            general: '#5865F2',
            economy: '#F1C40F',
            moderation: '#ED4245',
            xp: '#9B59B6',
            gamerole: '#FF0000',
            voice: '#57F287'
        }));

        expect(SettingsManager.validate('module_embed_colors', {})).toBe(true);
        expect(SettingsManager.validate('module_embed_colors', {
            economy: '#12ab34',
            xp: '#ABCDEF',
            voice: ''
        })).toBe(true);

        expect(SettingsManager.validate('module_embed_colors', ['#5865F2'])).toBe(false);
        expect(SettingsManager.validate('module_embed_colors', null)).toBe(false);
        expect(SettingsManager.validate('module_embed_colors', '#5865F2')).toBe(false);
        expect(SettingsManager.validate('module_embed_colors', { economy: '123456' })).toBe(false);
        expect(SettingsManager.validate('module_embed_colors', { economy: '#123' })).toBe(false);
        expect(SettingsManager.validate('module_embed_colors', { economy: '#GGGGGG' })).toBe(false);
        expect(SettingsManager.validate('module_embed_colors', { economy: 0x5865F2 })).toBe(false);
    });

    it('getEmbedColor should return custom guild module color or fall back cleanly', () => {
        db.prepare.mockReturnValue({
            get: vi.fn().mockImplementation((guildId, key) => {
                if (guildId === 'guild_themed' && key === 'module_embed_colors') {
                    return { value: JSON.stringify({ economy: '#112233', xp: '' }) };
                }
                return undefined;
            })
        });

        // Custom color lookup (including case-insensitive module name)
        expect(SettingsManager.getEmbedColor('guild_themed', 'economy', 0xF1C40F)).toBe(0x112233);
        expect(SettingsManager.getEmbedColor('guild_themed', 'ECONOMY', 0xF1C40F)).toBe(0x112233);

        // Empty custom color falls back to numeric fallbackColor, hex string fallbackColor, or default 0x5865F2
        expect(SettingsManager.getEmbedColor('guild_themed', 'xp', 0x9B59B6)).toBe(0x9B59B6);
        expect(SettingsManager.getEmbedColor('guild_themed', 'moderation', '#ED4245')).toBe(0xED4245);
        expect(SettingsManager.getEmbedColor('guild_default', 'general')).toBe(0x5865F2);
    });

    it('validate and normalizeCommandRoles should support single-role strings and multi-role string[] arrays', () => {
        expect(SettingsManager.validate('command_roles', {
            ban: '111222333',
            kick: ['111222333', '444555666'],
            'voice lock': []
        })).toBe(true);

        expect(SettingsManager.validate('command_roles', ['111222333'])).toBe(false);
        expect(SettingsManager.validate('command_roles', null)).toBe(false);
        expect(SettingsManager.validate('command_roles', { ban: 12345 })).toBe(false);
        expect(SettingsManager.validate('command_roles', { ban: ['111222333', 999] })).toBe(false);
        expect(SettingsManager.validate('command_roles', { ban: [null] })).toBe(false);
        expect(SettingsManager.validate('role_rewards', ['111222333'])).toBe(false);

        expect(SettingsManager.normalizeCommandRoles('12345')).toEqual(['12345']);
        expect(SettingsManager.normalizeCommandRoles('"12345"')).toEqual(['12345']);
        expect(SettingsManager.normalizeCommandRoles('   ')).toEqual([]);
        expect(SettingsManager.normalizeCommandRoles(null)).toEqual([]);
        expect(SettingsManager.normalizeCommandRoles(undefined)).toEqual([]);
        expect(SettingsManager.normalizeCommandRoles(['"111"', " '222' ", '', '111', '333', '222'])).toEqual(['111', '222', '333']);
    });

    it('setGuildMany should sanitize quotes in command_roles strings/arrays and reject invalid array items', () => {
        const mockRun = vi.fn();
        db.prepare.mockReturnValue({ run: mockRun });
        db.transaction = vi.fn((fn) => (items) => fn(items));

        SettingsManager.setGuildMany('guild_roles_batch', {
            command_roles: {
                ban: '"111111111111111111"',
                'voice lock': ['"222222222222222222"', "'333333333333333333'", '', '222222222222222222']
            },
            module_embed_colors: {
                economy: '#F1C40F'
            }
        });

        expect(mockRun).toHaveBeenCalledWith(
            'guild_roles_batch',
            'command_roles',
            JSON.stringify({
                ban: '111111111111111111',
                'voice lock': ['222222222222222222', '333333333333333333']
            })
        );
        expect(mockRun).toHaveBeenCalledWith(
            'guild_roles_batch',
            'module_embed_colors',
            JSON.stringify({ economy: '#F1C40F' })
        );

        expect(() => {
            SettingsManager.setGuildMany('guild_roles_batch', {
                command_roles: { ban: ['111111111111111111', 999] }
            });
        }).toThrow(/Invalid value for setting command_roles/);
    });
});
