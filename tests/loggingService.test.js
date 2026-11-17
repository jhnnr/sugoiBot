import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loggingService, resolveAuditMentions } from '../lib/bot/loggingService.js';
import { SettingsManager } from '../lib/settings.js';
import db from '../lib/database.js';

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

    it('should resolve <@userId>, <@!userId>, <#channelId>, and <@&roleId> mentions across passed user, caches, and historical SQLite audit_logs', () => {
        const mentionGuildId = 'g_mention_resolve_' + Date.now();

        // Seed a historical SQLite row so userId 517108999527727126 is known in audit_logs as sugoi.js
        loggingService.recordAuditLog(mentionGuildId, {
            title: 'Voice Activity',
            description: 'Historical voice join',
            eventType: 'log_events_voice',
            user: { id: '517108999527727126', username: 'sugoi.js#0' }
        });

        const fakeGuild = {
            id: mentionGuildId,
            name: 'Mention Resolution Server',
            client: {
                user: { id: '1562149253504049192', username: 'sugoiBot' },
                users: {
                    cache: new Map([
                        ['777777777777777777', { id: '777777777777777777', username: 'CachedGlobalUser' }]
                    ])
                }
            },
            members: {
                cache: new Map([
                    ['888888888888888888', { id: '888888888888888888', user: { id: '888888888888888888', username: 'GuildMemberUser' } }]
                ])
            },
            channels: {
                cache: new Map([
                    ['444444444444444444', { id: '444444444444444444', name: 'mod-log-room' }]
                ])
            },
            roles: {
                cache: new Map([
                    ['555555555555555555', { id: '555555555555555555', name: 'VoiceModerator' }]
                ])
            }
        };

        const rawDesc = '<@517108999527727126> was moved from voice channel **➕ Join to Create** to **dota o ako** by <@1562149253504049192> in <#444444444444444444> with <@&555555555555555555> and <@!888888888888888888> / <@777777777777777777> / <@!999999999999999999>';
        const resolved = resolveAuditMentions(rawDesc, {
            guild: fakeGuild,
            client: fakeGuild.client,
            user: { id: '999999999999999999', tag: 'PassedActor#0' }
        });

        expect(resolved).toBe(
            '@sugoi.js was moved from voice channel **➕ Join to Create** to **dota o ako** by @sugoiBot in #mod-log-room with @VoiceModerator and @GuildMemberUser / @CachedGlobalUser / @PassedActor'
        );

        // Also verify historical rows containing raw <@id> in SQLite are dynamically resolved on getAuditLogs()
        db.prepare(`
            INSERT INTO audit_logs (guildId, eventType, title, description, color, userId, username, userTag, fields, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            mentionGuildId,
            'log_events_voice',
            'Voice Activity',
            '<@517108999527727126> left voice channel **dota o ako** (handled by <@1562149253504049192>)',
            0xF23F43,
            '517108999527727126',
            'sugoi.js',
            'sugoi.js',
            '[]',
            Date.now() + 100
        );

        const logs = loggingService.getAuditLogs(mentionGuildId, {
            limit: 5,
            guild: fakeGuild,
            client: fakeGuild.client
        });
        expect(logs[0].description).toBe('@sugoi.js left voice channel **dota o ako** (handled by @sugoiBot)');
        expect(logs[0].username).toBe('sugoi.js');
        expect(logs[0].userTag).toBe('sugoi.js');
    });

    it('should preserve native <@id> mentions in Discord channel embeds while storing resolved @username mentions in dashboard audit_logs', async () => {
        const dualGuildId = 'g_dual_embed_' + Date.now();
        SettingsManager.getGuildJson.mockReturnValue(true);
        SettingsManager.getGuild.mockReturnValue('123456789012345678');

        const fetchUserMock = vi.fn().mockImplementation(async (id) => {
            if (id === '1562149253504049192') {
                return { id: '1562149253504049192', username: 'sugoiBot' };
            }
            return null;
        });

        const guildWithClient = {
            id: dualGuildId,
            name: 'Dual Format Guild',
            channels: {
                cache: new Map([['123456789012345678', mockChannel]]),
                fetch: vi.fn().mockResolvedValue(mockChannel)
            },
            members: {
                cache: new Map()
            },
            roles: {
                cache: new Map([['333333333333333333', { id: '333333333333333333', name: 'Staff' }]])
            },
            client: {
                user: { id: '900000000000000001', username: 'MainBot' },
                users: {
                    cache: new Map(),
                    fetch: fetchUserMock
                }
            }
        };

        const rawVoiceMoveDescription = '<@517108999527727126> was moved from voice channel **➕ Join to Create** to **dota o ako** by <@1562149253504049192>';

        await loggingService.log(guildWithClient, {
            title: 'Voice Activity',
            description: rawVoiceMoveDescription,
            eventType: 'log_events_voice',
            color: 0xFEE75C,
            user: {
                id: '517108999527727126',
                username: 'sugoi.js',
                displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/sugoi.png'
            }
        });

        // 1. Uncached user <@1562149253504049192> was prefetched via guild.client.users.fetch
        expect(fetchUserMock).toHaveBeenCalledWith('1562149253504049192');

        // 2. Discord embed sent to logChannel.send preserves native <@id> mentions for Discord client
        expect(mockSend).toHaveBeenCalledTimes(1);
        const sentEmbed = mockSend.mock.calls[0][0].embeds[0];
        expect(sentEmbed.data.description).toBe(rawVoiceMoveDescription);

        // 3. Dashboard audit_logs entry has resolved @username mentions
        const savedLogs = loggingService.getAuditLogs(dualGuildId, { limit: 5 });
        expect(savedLogs.length).toBe(1);
        expect(savedLogs[0].description).toBe(
            '@sugoi.js was moved from voice channel **➕ Join to Create** to **dota o ako** by @sugoiBot'
        );
        expect(savedLogs[0].username).toBe('sugoi.js');
        expect(savedLogs[0].userTag).toBe('sugoi.js');
    });
});
