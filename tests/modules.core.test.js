import { describe, it, expect, vi, beforeEach } from 'vitest';
import guildMemberAddEvent from '../modules/core/events/guildMemberAdd.js';
import guildMemberRemoveEvent from '../modules/core/events/guildMemberRemove.js';
import messageDeleteEvent from '../modules/core/events/messageDelete.js';
import userUpdateEvent from '../modules/core/events/userUpdate.js';
import guildMemberUpdateEvent from '../modules/core/events/guildMemberUpdate.js';
import { loggingService } from '../lib/bot/loggingService.js';
import { SettingsManager } from '../lib/settings.js';

vi.mock('../lib/bot/loggingService.js', () => ({
    loggingService: {
        log: vi.fn().mockResolvedValue(true),
    },
}));

vi.mock('../lib/settings.js', () => ({
    SettingsManager: {
        getGuildJson: vi.fn().mockReturnValue(true),
        getGuild: vi.fn().mockReturnValue('log_ch_1'),
        get: vi.fn().mockReturnValue('log_ch_1')
    },
}));

describe('Core Module Events', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('guildMemberAdd (Invite Tracking)', () => {
        it('should detect used invite and log member join with inviter tag', async () => {
            const cachedInvites = new Map([
                ['inv1', 2],
                ['inv2', 5]
            ]);

            const newInvites = new Map([
                ['inv1', { code: 'inv1', uses: 3, inviter: { id: 'inviter1', tag: 'Inviter#0001' } }], // used
                ['inv2', { code: 'inv2', uses: 5, inviter: { id: 'inviter2', tag: 'Other#0002' } }]
            ]);

            const mockGuild = {
                id: 'g400',
                invites: {
                    fetch: vi.fn().mockResolvedValue(newInvites)
                }
            };

            const mockMember = {
                id: 'new_member_1',
                user: { tag: 'NewUser#9999', createdTimestamp: Date.now() - 100000 },
                guild: mockGuild,
                client: {
                    invites: new Map([['g400', cachedInvites]])
                }
            };

            await guildMemberAddEvent.execute(mockMember);

            expect(loggingService.log).toHaveBeenCalledWith(
                mockGuild,
                expect.objectContaining({
                    title: 'Member Joined',
                    eventType: 'log_events_member_join',
                    fields: expect.arrayContaining([
                        expect.objectContaining({ name: '📨 Invited By', value: expect.stringContaining('Inviter#0001') }),
                        expect.objectContaining({ name: '🔗 Invite Code', value: '`inv1`' })
                    ])
                })
            );
        });
    });

    describe('guildMemberRemove', () => {
        it('should log member departure', async () => {
            const mockGuild = { id: 'g400' };
            const mockMember = {
                id: 'departed_user',
                user: { tag: 'Departed#1234' },
                guild: mockGuild
            };

            await guildMemberRemoveEvent.execute(mockMember);

            expect(loggingService.log).toHaveBeenCalledWith(
                mockGuild,
                expect.objectContaining({
                    eventType: 'log_events_member_leave',
                    description: expect.stringContaining('Departed#1234')
                })
            );
        });
    });

    describe('messageDelete', () => {
        it('should ignore bot message deletes', async () => {
            const message = {
                author: { bot: true },
                guild: { id: 'g400' }
            };

            await messageDeleteEvent.execute(message);
            expect(loggingService.log).not.toHaveBeenCalled();
        });

        it('should log deleted user message content', async () => {
            const mockGuild = { id: 'g400' };
            const message = {
                author: { bot: false, toString: () => '<@u400>' },
                channel: { toString: () => '<#ch400>' },
                content: 'Secret message that was removed',
                guild: mockGuild
            };

            await messageDeleteEvent.execute(message);

            expect(loggingService.log).toHaveBeenCalledWith(
                mockGuild,
                expect.objectContaining({
                    eventType: 'log_events_message_delete',
                    description: expect.stringContaining('Secret message that was removed')
                })
            );
        });
    });

    describe('userUpdate (Global Avatar Change)', () => {
        it('should ignore if avatar did not change', async () => {
            const oldUser = { avatar: 'same_hash' };
            const newUser = { avatar: 'same_hash' };

            await userUpdateEvent.execute(oldUser, newUser);
            expect(SettingsManager.getGuildJson).not.toHaveBeenCalled();
        });

        it('should log avatar changes to mutual guilds', async () => {
            const mockSend = vi.fn().mockResolvedValue(true);
            const mockChannel = { send: mockSend };
            const mockGuild = {
                id: 'g400',
                members: {
                    fetch: vi.fn().mockResolvedValue({ id: 'u400' })
                },
                channels: {
                    fetch: vi.fn().mockResolvedValue(mockChannel)
                }
            };

            const oldUser = {
                id: 'u400',
                avatar: 'old_avatar_hash',
                displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/old.png'
            };
            const newUser = {
                id: 'u400',
                tag: 'UpdatedUser#0001',
                avatar: 'new_avatar_hash',
                displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/new.png',
                client: {
                    guilds: {
                        cache: new Map([['g400', mockGuild]])
                    }
                }
            };

            await userUpdateEvent.execute(oldUser, newUser);
            expect(loggingService.log).toHaveBeenCalledWith(
                mockGuild,
                expect.objectContaining({
                    title: 'Avatar Changed',
                    eventType: 'log_events_member_update'
                })
            );
        });
    });

    describe('guildMemberUpdate (Server Avatar Change)', () => {
        it('should ignore if server avatar did not change', async () => {
            const oldMember = { avatar: 'same_server_avatar', guild: { id: 'g400' } };
            const newMember = { avatar: 'same_server_avatar', guild: { id: 'g400' } };

            await guildMemberUpdateEvent.execute(oldMember, newMember);
            expect(loggingService.log).not.toHaveBeenCalled();
        });

        it('should log server-specific avatar changes', async () => {
            const mockGuild = {
                id: 'g400',
                name: 'Server Name'
            };

            const oldMember = {
                id: 'u400',
                avatar: 'old_guild_avatar',
                guild: mockGuild,
                displayAvatarURL: () => 'https://cdn.discordapp.com/guilds/old.png'
            };
            const newMember = {
                id: 'u400',
                user: { tag: 'User#0001' },
                avatar: 'new_guild_avatar',
                guild: mockGuild,
                displayAvatarURL: () => 'https://cdn.discordapp.com/guilds/new.png'
            };

            await guildMemberUpdateEvent.execute(oldMember, newMember);
            expect(loggingService.log).toHaveBeenCalledWith(
                mockGuild,
                expect.objectContaining({
                    title: 'Server Avatar Changed',
                    eventType: 'log_events_member_update'
                })
            );
        });
    });

    describe('channelCreate event', () => {
        it('should log channel creation with creator if audit log found', async () => {
            const { default: channelCreateEvent } = await import('../modules/core/events/channelCreate.js');
            const mockCreator = { id: 'admin1', tag: 'Creator#0001', toString: () => '<@admin1>' };
            const mockGuild = {
                id: 'g400',
                members: {
                    me: {
                        permissions: { has: vi.fn().mockReturnValue(true) }
                    }
                },
                fetchAuditLogs: vi.fn().mockResolvedValue({
                    entries: {
                        first: () => ({
                            targetId: 'ch_created_1',
                            createdTimestamp: Date.now() - 500,
                            executor: mockCreator
                        })
                    }
                })
            };

            const mockChannel = {
                id: 'ch_created_1',
                name: 'announcements',
                type: 0,
                guild: mockGuild,
                toString: () => '<#ch_created_1>'
            };

            await channelCreateEvent.execute(mockChannel);

            expect(loggingService.log).toHaveBeenCalledWith(
                mockGuild,
                expect.objectContaining({
                    eventType: 'log_events_channels',
                    description: '📁 Text channel created: **announcements**'
                })
            );
        });
    });

    describe('channelDelete event', () => {
        it('should log channel deletion with deleter if audit log found', async () => {
            const { default: channelDeleteEvent } = await import('../modules/core/events/channelDelete.js');
            const mockDeleter = { id: 'admin2', tag: 'Deleter#0002', toString: () => '<@admin2>' };
            const mockGuild = {
                id: 'g400',
                members: {
                    me: {
                        permissions: { has: vi.fn().mockReturnValue(true) }
                    }
                },
                fetchAuditLogs: vi.fn().mockResolvedValue({
                    entries: {
                        first: () => ({
                            targetId: 'ch_deleted_1',
                            createdTimestamp: Date.now() - 500,
                            executor: mockDeleter
                        })
                    }
                })
            };

            const mockChannel = {
                id: 'ch_deleted_1',
                name: 'old-chat',
                type: 0,
                guild: mockGuild
            };

            await channelDeleteEvent.execute(mockChannel);

            expect(loggingService.log).toHaveBeenCalledWith(
                mockGuild,
                expect.objectContaining({
                    eventType: 'log_events_channels',
                    description: '🗑 Text channel deleted: **old-chat**'
                })
            );
        });
    });
});
