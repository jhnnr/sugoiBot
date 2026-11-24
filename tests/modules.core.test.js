import { describe, it, expect, vi, beforeEach } from 'vitest';
import guildMemberAddEvent from '../modules/core/events/guildMemberAdd.js';
import guildMemberRemoveEvent from '../modules/core/events/guildMemberRemove.js';
import messageDeleteEvent from '../modules/core/events/messageDelete.js';
import userUpdateEvent from '../modules/core/events/userUpdate.js';
import guildMemberUpdateEvent from '../modules/core/events/guildMemberUpdate.js';
import interactionCreateEvent from '../modules/core/events/interactionCreate.js';
import { loggingService } from '../lib/bot/loggingService.js';
import { SettingsManager } from '../lib/settings.js';

vi.mock('../lib/bot/loggingService.js', () => ({
    loggingService: {
        log: vi.fn().mockResolvedValue(true),
    },
}));

vi.mock('../lib/settings.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        SettingsManager: {
            ...actual.SettingsManager,
            getGuildJson: vi.fn().mockReturnValue(true),
            setGuildJson: vi.fn().mockReturnValue(true),
            getGuild: vi.fn().mockReturnValue('log_ch_1'),
            get: vi.fn().mockReturnValue('log_ch_1'),
            getEmbedColor: vi.fn((guildId, mod, fallback = 0x5865F2) => fallback)
        },
    };
});

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
                    eventType: 'log_events_member_update',
                    description: '<@u400> updated their profile!',
                    footerText: 'User ID: u400'
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
                    eventType: 'log_events_member_update',
                    description: '<@u400> updated their server profile!',
                    footerText: 'User ID: u400'
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

    describe('roleCreate event', () => {
        it('should log role creation with creator if audit log found', async () => {
            const { default: roleCreateEvent } = await import('../modules/core/events/roleCreate.js');
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
                            targetId: 'role_created_1',
                            createdTimestamp: Date.now() - 500,
                            executor: mockCreator
                        })
                    }
                })
            };

            const mockRole = {
                id: 'role_created_1',
                name: 'VIP',
                guild: mockGuild
            };

            await roleCreateEvent.execute(mockRole);

            expect(loggingService.log).toHaveBeenCalledWith(
                mockGuild,
                expect.objectContaining({
                    eventType: 'log_events_roles',
                    description: expect.stringContaining('Role created: **VIP**')
                })
            );
        });
    });

    describe('roleDelete event', () => {
        it('should log role deletion with deleter if audit log found', async () => {
            const { default: roleDeleteEvent } = await import('../modules/core/events/roleDelete.js');
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
                            targetId: 'role_deleted_1',
                            createdTimestamp: Date.now() - 500,
                            executor: mockDeleter
                        })
                    }
                })
            };

            const mockRole = {
                id: 'role_deleted_1',
                name: 'OldRole',
                guild: mockGuild
            };

            await roleDeleteEvent.execute(mockRole);

            expect(loggingService.log).toHaveBeenCalledWith(
                mockGuild,
                expect.objectContaining({
                    eventType: 'log_events_roles',
                    description: expect.stringContaining('Role deleted: **OldRole**')
                })
            );
        });
    });

    describe('/cmdperm command', () => {
        it('should set command role requirement', async () => {
            const { default: cmdpermCommand } = await import('../modules/core/commands/cmdperm.js');
            const { SettingsManager } = await import('../lib/settings.js');
            const setSpy = vi.spyOn(SettingsManager, 'setGuildJson').mockReturnValue();
            const getSpy = vi.spyOn(SettingsManager, 'getGuildJson').mockReturnValue({});

            const reply = vi.fn();
            const interaction = {
                guild: { id: 'g400' },
                options: {
                    getSubcommand: () => 'set',
                    getString: () => 'ban',
                    getRole: () => ({ id: 'role_mod', toString: () => '<@&role_mod>' })
                },
                reply
            };

            await cmdpermCommand.execute(interaction);

            expect(setSpy).toHaveBeenCalledWith('g400', 'command_roles', { ban: 'role_mod' });
            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('now requires the <@&role_mod> role')
            }));

            setSpy.mockRestore();
            getSpy.mockRestore();
        });

        it('should clear command role requirement', async () => {
            const { default: cmdpermCommand } = await import('../modules/core/commands/cmdperm.js');
            const { SettingsManager } = await import('../lib/settings.js');
            const setSpy = vi.spyOn(SettingsManager, 'setGuildJson').mockReturnValue();
            const getSpy = vi.spyOn(SettingsManager, 'getGuildJson').mockReturnValue({ ban: 'role_mod' });

            const reply = vi.fn();
            const interaction = {
                guild: { id: 'g400' },
                options: {
                    getSubcommand: () => 'clear',
                    getString: () => 'ban'
                },
                reply
            };

            await cmdpermCommand.execute(interaction);

            expect(setSpy).toHaveBeenCalledWith('g400', 'command_roles', {});
            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Reset `/ban` to default permissions')
            }));

            setSpy.mockRestore();
            getSpy.mockRestore();
        });

        it('should set multiple roles with deduplication via role..role5 options', async () => {
            const { default: cmdpermCommand } = await import('../modules/core/commands/cmdperm.js');
            const setSpy = vi.spyOn(SettingsManager, 'setGuildJson').mockReturnValue();
            const getSpy = vi.spyOn(SettingsManager, 'getGuildJson').mockReturnValue({});

            const rolesMap = {
                role: { id: 'role_mod' },
                role2: { id: 'role_trial_mod' },
                role3: { id: 'role_mod' }, // duplicate should be ignored
                role4: null,
                role5: { id: 'role_helper' }
            };
            const reply = vi.fn();
            const interaction = {
                guild: { id: 'g400' },
                options: {
                    getSubcommand: () => 'set',
                    getString: () => '/voice lock',
                    getRole: (name) => rolesMap[name] || null
                },
                reply
            };

            await cmdpermCommand.execute(interaction);

            expect(setSpy).toHaveBeenCalledWith('g400', 'command_roles', {
                'voice lock': ['role_mod', 'role_trial_mod', 'role_helper']
            });
            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('requires one of the following roles to execute: <@&role_mod>, <@&role_trial_mod>, <@&role_helper>'),
                ephemeral: true
            }));

            setSpy.mockRestore();
            getSpy.mockRestore();
        });

        it('should add and remove roles on a command and reset when the last role is removed', async () => {
            const { default: cmdpermCommand } = await import('../modules/core/commands/cmdperm.js');
            let storedRoles = { ban: 'role_mod' };
            const getSpy = vi.spyOn(SettingsManager, 'getGuildJson').mockImplementation(() => storedRoles);
            const setSpy = vi.spyOn(SettingsManager, 'setGuildJson').mockImplementation((gId, key, val) => {
                storedRoles = { ...val };
            });

            // 1. Add second role to existing single-role command
            const addReply = vi.fn();
            await cmdpermCommand.execute({
                guild: { id: 'g400' },
                options: {
                    getSubcommand: () => 'add',
                    getString: () => 'ban',
                    getRole: () => ({ id: 'role_admin_jr' })
                },
                reply: addReply
            });
            expect(storedRoles.ban).toEqual(['role_mod', 'role_admin_jr']);
            expect(addReply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Allowed roles: <@&role_mod>, <@&role_admin_jr>'),
                ephemeral: true
            }));

            // 2. Remove non-existent role returns informational notice without mutating
            const missingRemoveReply = vi.fn();
            await cmdpermCommand.execute({
                guild: { id: 'g400' },
                options: {
                    getSubcommand: () => 'remove',
                    getString: () => 'ban',
                    getRole: () => ({ id: 'role_other' })
                },
                reply: missingRemoveReply
            });
            expect(storedRoles.ban).toEqual(['role_mod', 'role_admin_jr']);
            expect(missingRemoveReply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('is not currently configured'),
                ephemeral: true
            }));

            // 3. Remove first role -> keeps remaining ['role_admin_jr']
            const firstRemoveReply = vi.fn();
            await cmdpermCommand.execute({
                guild: { id: 'g400' },
                options: {
                    getSubcommand: () => 'remove',
                    getString: () => 'ban',
                    getRole: () => ({ id: 'role_mod' })
                },
                reply: firstRemoveReply
            });
            expect(storedRoles.ban).toEqual(['role_admin_jr']);
            expect(firstRemoveReply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Remaining allowed roles: <@&role_admin_jr>'),
                ephemeral: true
            }));

            // 4. Remove final role -> deletes command key and resets to Everyone
            const finalRemoveReply = vi.fn();
            await cmdpermCommand.execute({
                guild: { id: 'g400' },
                options: {
                    getSubcommand: () => 'remove',
                    getString: () => 'ban',
                    getRole: () => ({ id: 'role_admin_jr' })
                },
                reply: finalRemoveReply
            });
            expect(storedRoles).toEqual({});
            expect(finalRemoveReply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Reset to default permissions'),
                ephemeral: true
            }));

            setSpy.mockRestore();
            getSpy.mockRestore();
        });

        it('should list single and multi-role command permissions with custom core embed color', async () => {
            const { default: cmdpermCommand } = await import('../modules/core/commands/cmdperm.js');
            const getSpy = vi.spyOn(SettingsManager, 'getGuildJson').mockReturnValue({
                ban: 'role_mod',
                'voice lock': ['role_dj', 'role_vip']
            });
            const colorSpy = vi.spyOn(SettingsManager, 'getEmbedColor').mockReturnValue(0xABCDEF);

            const reply = vi.fn();
            await cmdpermCommand.execute({
                guild: { id: 'g400', name: 'Test Guild' },
                options: {
                    getSubcommand: () => 'list'
                },
                reply
            });

            expect(colorSpy).toHaveBeenCalledWith('g400', 'core', 0x5865F2);
            expect(reply).toHaveBeenCalledTimes(1);
            const embedJson = reply.mock.calls[0][0].embeds[0].toJSON();
            expect(embedJson.color).toBe(0xABCDEF);
            expect(embedJson.description).toContain('`/ban` → Requires <@&role_mod>');
            expect(embedJson.description).toContain('`/voice lock` → Requires <@&role_dj>, <@&role_vip>');

            colorSpy.mockRestore();
            getSpy.mockRestore();
        });
    });

    describe('interactionCreate command_roles gating', () => {
        it('should reject command execution if user lacks the required role', async () => {
            const { SettingsManager } = await import('../lib/settings.js');
            const getSpy = vi.spyOn(SettingsManager, 'getGuildJson').mockImplementation((guildId, key) => {
                if (key === 'command_roles') return { ban: 'role_required_1' };
                return true;
            });

            const reply = vi.fn();
            const mockCommand = { data: { name: 'ban' }, execute: vi.fn(), module: 'moderation' };
            const interaction = {
                isChatInputCommand: () => true,
                commandName: 'ban',
                guild: { id: 'g400', ownerId: 'owner999' },
                user: { id: 'user123' },
                member: {
                    permissions: { has: vi.fn().mockReturnValue(false) },
                    roles: { cache: new Map() }
                },
                client: {
                    commands: new Map([['ban', mockCommand]]),
                    cooldowns: new Map()
                },
                reply
            };

            await interactionCreateEvent.execute(interaction);

            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('You need the <@&role_required_1> role to use `/ban`'),
                ephemeral: true
            }));
            expect(mockCommand.execute).not.toHaveBeenCalled();

            getSpy.mockRestore();
        });

        it('should allow command execution if user has the required role', async () => {
            const { SettingsManager } = await import('../lib/settings.js');
            const getSpy = vi.spyOn(SettingsManager, 'getGuildJson').mockImplementation((guildId, key) => {
                if (key === 'command_roles') return { ban: 'role_required_1' };
                return true;
            });

            const reply = vi.fn();
            const mockCommand = { data: { name: 'ban' }, execute: vi.fn(), module: 'moderation' };
            const interaction = {
                isChatInputCommand: () => true,
                commandName: 'ban',
                guild: { id: 'g400', ownerId: 'owner999' },
                user: { id: 'user123' },
                member: {
                    permissions: { has: vi.fn().mockReturnValue(false) },
                    roles: { cache: new Map([['role_required_1', { id: 'role_required_1' }]]) }
                },
                client: {
                    commands: new Map([['ban', mockCommand]]),
                    cooldowns: new Map()
                },
                reply
            };

            await interactionCreateEvent.execute(interaction);

            expect(mockCommand.execute).toHaveBeenCalled();

            getSpy.mockRestore();
        });

        it('should allow subcommand execution if user has the parent command role', async () => {
            const { SettingsManager } = await import('../lib/settings.js');
            const getSpy = vi.spyOn(SettingsManager, 'getGuildJson').mockImplementation((guildId, key) => {
                if (key === 'command_roles') return { voice: 'role_voice_master' };
                return true;
            });

            const reply = vi.fn();
            const mockCommand = { data: { name: 'voice' }, execute: vi.fn(), module: 'voice' };
            const interaction = {
                isChatInputCommand: () => true,
                commandName: 'voice',
                options: { getSubcommand: () => 'lock' },
                guild: { id: 'g400', ownerId: 'owner999' },
                user: { id: 'user123' },
                member: {
                    permissions: { has: vi.fn().mockReturnValue(false) },
                    roles: { cache: new Map([['role_voice_master', { id: 'role_voice_master' }]]) }
                },
                client: {
                    commands: new Map([['voice', mockCommand]]),
                    cooldowns: new Map()
                },
                reply
            };

            await interactionCreateEvent.execute(interaction);

            expect(mockCommand.execute).toHaveBeenCalled();

            getSpy.mockRestore();
        });

        it('should reject subcommand execution if user lacks the specific subcommand role override', async () => {
            const { SettingsManager } = await import('../lib/settings.js');
            const getSpy = vi.spyOn(SettingsManager, 'getGuildJson').mockImplementation((guildId, key) => {
                if (key === 'command_roles') return { 'voice lock': 'role_vip_lock' };
                return true;
            });

            const reply = vi.fn();
            const mockCommand = { data: { name: 'voice' }, execute: vi.fn(), module: 'voice' };
            const interaction = {
                isChatInputCommand: () => true,
                commandName: 'voice',
                options: { getSubcommand: () => 'lock' },
                guild: { id: 'g400', ownerId: 'owner999' },
                user: { id: 'user123' },
                member: {
                    permissions: { has: vi.fn().mockReturnValue(false) },
                    roles: { cache: new Map() }
                },
                client: {
                    commands: new Map([['voice', mockCommand]]),
                    cooldowns: new Map()
                },
                reply
            };

            await interactionCreateEvent.execute(interaction);

            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('You need the <@&role_vip_lock> role to use `/voice lock`'),
                ephemeral: true
            }));
            expect(mockCommand.execute).not.toHaveBeenCalled();

            getSpy.mockRestore();
        });

        it('should allow execution when user holds ANY role in a multi-role command_roles array and block with multi-role message when holding none', async () => {
            const getSpy = vi.spyOn(SettingsManager, 'getGuildJson').mockImplementation((guildId, key) => {
                if (key === 'command_roles') return { ban: ['role_sr_mod', 'role_jr_mod'] };
                return true;
            });

            const mockCommand = { data: { name: 'ban' }, execute: vi.fn(), module: 'moderation' };

            // 1. User holds none of the required roles -> blocked with multi-role list
            const deniedReply = vi.fn();
            await interactionCreateEvent.execute({
                isChatInputCommand: () => true,
                commandName: 'ban',
                guild: { id: 'g400', ownerId: 'owner999' },
                user: { id: 'user_no_role' },
                member: {
                    permissions: { has: vi.fn().mockReturnValue(false) },
                    roles: { cache: new Map([['unrelated_role', { id: 'unrelated_role' }]]) }
                },
                client: {
                    commands: new Map([['ban', mockCommand]]),
                    cooldowns: new Map()
                },
                reply: deniedReply
            });

            expect(deniedReply).toHaveBeenCalledWith({
                content: '⚠️ You need one of the following roles to use `/ban`: <@&role_sr_mod>, <@&role_jr_mod>.',
                ephemeral: true
            });
            expect(mockCommand.execute).not.toHaveBeenCalled();

            // 2. User holds the second role in the array -> allowed
            const allowedReply = vi.fn();
            await interactionCreateEvent.execute({
                isChatInputCommand: () => true,
                commandName: 'ban',
                guild: { id: 'g400', ownerId: 'owner999' },
                user: { id: 'user_jr_mod' },
                member: {
                    permissions: { has: vi.fn().mockReturnValue(false) },
                    roles: { cache: new Map([['role_jr_mod', { id: 'role_jr_mod' }]]) }
                },
                client: {
                    commands: new Map([['ban', mockCommand]]),
                    cooldowns: new Map()
                },
                reply: allowedReply
            });

            expect(mockCommand.execute).toHaveBeenCalledTimes(1);

            getSpy.mockRestore();
        });

        it('should enforce subcommand multi-role array override over parent command multi-role array', async () => {
            const getSpy = vi.spyOn(SettingsManager, 'getGuildJson').mockImplementation((guildId, key) => {
                if (key === 'command_roles') {
                    return {
                        voice: ['role_voice_parent_1', 'role_voice_parent_2'],
                        'voice lock': ['role_lock_vip_1', 'role_lock_vip_2']
                    };
                }
                return true;
            });

            const mockCommand = { data: { name: 'voice' }, execute: vi.fn(), module: 'voice' };

            // User only has parent role -> blocked from '/voice lock' due to subcommand array override
            const deniedSubReply = vi.fn();
            await interactionCreateEvent.execute({
                isChatInputCommand: () => true,
                commandName: 'voice',
                options: { getSubcommand: () => 'lock' },
                guild: { id: 'g400', ownerId: 'owner999' },
                user: { id: 'user_parent_only' },
                member: {
                    permissions: { has: vi.fn().mockReturnValue(false) },
                    roles: { cache: new Map([['role_voice_parent_1', { id: 'role_voice_parent_1' }]]) }
                },
                client: {
                    commands: new Map([['voice', mockCommand]]),
                    cooldowns: new Map()
                },
                reply: deniedSubReply
            });

            expect(deniedSubReply).toHaveBeenCalledWith({
                content: '⚠️ You need one of the following roles to use `/voice lock`: <@&role_lock_vip_1>, <@&role_lock_vip_2>.',
                ephemeral: true
            });
            expect(mockCommand.execute).not.toHaveBeenCalled();

            // Same user uses '/voice rename' (no subcommand override) -> falls back to parent multi-role array and succeeds
            await interactionCreateEvent.execute({
                isChatInputCommand: () => true,
                commandName: 'voice',
                options: { getSubcommand: () => 'rename' },
                guild: { id: 'g400', ownerId: 'owner999' },
                user: { id: 'user_parent_only' },
                member: {
                    permissions: { has: vi.fn().mockReturnValue(false) },
                    roles: { cache: new Map([['role_voice_parent_1', { id: 'role_voice_parent_1' }]]) }
                },
                client: {
                    commands: new Map([['voice', mockCommand]]),
                    cooldowns: new Map()
                },
                reply: vi.fn()
            });
            expect(mockCommand.execute).toHaveBeenCalledTimes(1);

            // User holding second subcommand role -> allowed for '/voice lock'
            await interactionCreateEvent.execute({
                isChatInputCommand: () => true,
                commandName: 'voice',
                options: { getSubcommand: () => 'lock' },
                guild: { id: 'g400', ownerId: 'owner999' },
                user: { id: 'user_sub_vip_2' },
                member: {
                    permissions: { has: vi.fn().mockReturnValue(false) },
                    roles: { cache: new Map([['role_lock_vip_2', { id: 'role_lock_vip_2' }]]) }
                },
                client: {
                    commands: new Map([['voice', mockCommand]]),
                    cooldowns: new Map()
                },
                reply: vi.fn()
            });
            expect(mockCommand.execute).toHaveBeenCalledTimes(2);

            getSpy.mockRestore();
        });
    });
});
