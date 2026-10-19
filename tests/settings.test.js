import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsManager } from '../lib/settings.js';
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

    it('getGuild should fetch from guild_settings or fallback to global', () => {
        // Guild specific found
        db.prepare.mockReturnValueOnce({
            get: vi.fn().mockReturnValue({ value: 'custom_log' })
        });
        expect(SettingsManager.getGuild('guild123', 'log_channel_id')).toBe('custom_log');

        // Guild specific not found, fallback to global
        db.prepare.mockReturnValueOnce({
            get: vi.fn().mockReturnValue(undefined)
        }).mockReturnValueOnce({
            get: vi.fn().mockReturnValue({ value: 'global_log' })
        });
        expect(SettingsManager.getGuild('guild123', 'log_channel_id')).toBe('global_log');
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
});
