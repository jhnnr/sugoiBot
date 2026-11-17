import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loggingService } from '../lib/bot/loggingService.js';
import { SettingsManager } from '../lib/settings.js';

vi.mock('../lib/settings.js', () => ({
    SettingsManager: {
        getGuildJson: vi.fn(),
        getGuild: vi.fn(),
        get: vi.fn(),
    },
}));

describe('Logging Service', () => {
    let mockSend;
    let mockChannel;
    let mockGuild;

    beforeEach(() => {
        vi.clearAllMocks();
        mockSend = vi.fn().mockResolvedValue(true);
        mockChannel = {
            id: '123456789012345678',
            send: mockSend,
        };
        mockGuild = {
            id: 'g_log_1',
            name: 'Logging Guild',
            channels: {
                cache: new Map([['123456789012345678', mockChannel]]),
                fetch: vi.fn().mockResolvedValue(mockChannel),
            },
        };
    });

    it('should strip quotes from logChannelId and send log embed', async () => {
        // Mock returning a quoted string from settings
        SettingsManager.getGuild.mockReturnValue('"123456789012345678"');

        await loggingService.log(mockGuild, {
            title: 'Test Event',
            description: 'This is a test log message',
            color: 0x5865F2,
            fields: [{ name: 'Field 1', value: 'Value 1' }]
        });

        expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
            embeds: expect.any(Array)
        }));
    });

    it('should set author header with small avatar and username and include native timestamp', async () => {
        SettingsManager.getGuild.mockReturnValue('123456789012345678');

        const mockUser = {
            tag: 'Tester#0001',
            username: 'Tester',
            displayAvatarURL: vi.fn().mockReturnValue('https://cdn.discordapp.com/avatars/test.png')
        };

        await loggingService.log(mockGuild, {
            title: 'User Event',
            description: 'User performed an action',
            user: mockUser
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        const sentEmbed = mockSend.mock.calls[0][0].embeds[0];
        expect(sentEmbed.data.author.name).toBe('Tester');
        expect(sentEmbed.data.author.icon_url).toBe('https://cdn.discordapp.com/avatars/test.png');
        expect(sentEmbed.data.timestamp).toBeDefined();
        expect(sentEmbed.data.footer).toBeUndefined();
    });

    it('should skip sending if eventType is disabled for guild', async () => {
        SettingsManager.getGuildJson.mockReturnValue(false);

        await loggingService.log(mockGuild, {
            title: 'Disabled Event',
            eventType: 'log_events_voice'
        });

        expect(mockSend).not.toHaveBeenCalled();
    });

    it('should not throw if channel cannot be resolved', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        SettingsManager.getGuild.mockReturnValue('non_existent_channel');
        mockGuild.channels.cache.clear();
        mockGuild.channels.fetch.mockResolvedValue(null);

        await expect(loggingService.log(mockGuild, {
            title: 'Unresolvable Channel'
        })).resolves.not.toThrow();

        expect(mockSend).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('should persist audit logs to SQLite, emit real-time events, and support filtering even without a Discord log channel', async () => {
        const auditGuildId = 'g_audit_test_' + Date.now();
        SettingsManager.getGuildJson.mockReturnValue(true);
        SettingsManager.getGuild.mockReturnValue(null); // No Discord log_channel_id configured

        const receivedBySub = [];
        const receivedByEmitter = [];
        const unsubscribe = loggingService.subscribe(auditGuildId, (entry) => {
            receivedBySub.push(entry);
        });
        const onEmit = (entry) => {
            if (entry.guildId === auditGuildId) receivedByEmitter.push(entry);
        };
        loggingService.events.on('auditLog', onEmit);

        await loggingService.log({ id: auditGuildId, name: 'Audit Test Server' }, {
            title: 'Member Banned',
            description: 'Banned SpamBot#0001 for raid activity',
            eventType: 'log_events_moderation',
            color: 0xF23F43,
            user: { id: 'u_mod_1', username: 'StaffMod' },
            fields: [{ name: 'Reason', value: 'Raid spam' }]
        });

        loggingService.recordAuditLog(auditGuildId, {
            title: 'Channel Created',
            description: 'Created #announcements',
            eventType: 'log_events_channels',
            color: 0x5865F2,
            user: { id: 'u_admin_2', username: 'Architect' }
        });

        unsubscribe();
        loggingService.events.off('auditLog', onEmit);

        // Verify subscriber and EventEmitter received both entries
        expect(receivedBySub.length).toBe(2);
        expect(receivedByEmitter.length).toBe(2);
        expect(receivedBySub[0].title).toBe('Member Banned');
        expect(receivedBySub[0].username).toBe('StaffMod');

        // Verify unsubscribed listener no longer receives events
        loggingService.recordAuditLog(auditGuildId, {
            title: 'After Unsubscribe',
            description: 'Should not trigger unsubscribed callback',
            eventType: 'log_events_commands'
        });
        expect(receivedBySub.length).toBe(2);

        // Verify SQLite persistence and filtering via getAuditLogs
        const allLogs = loggingService.getAuditLogs(auditGuildId, { limit: 10 });
        expect(allLogs.length).toBe(3);

        const modOnly = loggingService.getAuditLogs(auditGuildId, { eventType: 'log_events_moderation' });
        expect(modOnly.length).toBe(1);
        expect(modOnly[0].title).toBe('Member Banned');
        expect(modOnly[0].fields).toEqual([{ name: 'Reason', value: 'Raid spam' }]);

        const searched = loggingService.getAuditLogs(auditGuildId, { search: 'announcements' });
        expect(searched.length).toBe(1);
        expect(searched[0].eventType).toBe('log_events_channels');
    });
});
