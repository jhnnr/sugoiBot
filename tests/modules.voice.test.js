import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Events } from 'discord.js';
import voiceCommand from '../modules/voice/commands/voice.js';
import voiceStateUpdateEvent from '../modules/voice/events/voiceStateUpdate.js';
import interactionCreateEvent from '../modules/voice/events/interactionCreate.js';
import channelDeleteEvent from '../modules/voice/events/channelDelete.js';
import channelUpdateEvent from '../modules/voice/events/channelUpdate.js';
import readyEvent from '../modules/voice/events/ready.js';
import {
    emitVoiceUpdate,
    subscribeVoiceUpdates,
    deleteVoiceRoomRecord,
    reconcileGuildVoiceRooms
} from '../modules/voice/lib/voiceHelper.js';
import db from '../lib/database.js';
import { SettingsManager } from '../lib/settings.js';

vi.mock('../lib/database.js', () => ({
    default: {
        prepare: vi.fn(),
    },
}));

vi.mock('../lib/settings.js', () => ({
    SettingsManager: {
        getGuildJson: vi.fn().mockReturnValue(true),
        getGuild: vi.fn().mockReturnValue("{username}'s Room"),
    },
}));

describe('Voice Module', () => {
    let mockGuild;
    let mockMember;
    let mockVoiceChannel;

    beforeEach(() => {
        vi.clearAllMocks();
        mockVoiceChannel = {
            id: 'temp_vc_100',
            name: "Tester's Room",
            userLimit: 0,
            members: new Map(),
            permissionOverwrites: {
                edit: vi.fn().mockResolvedValue(true)
            },
            setName: vi.fn().mockResolvedValue(true),
            setUserLimit: vi.fn().mockResolvedValue(true),
            delete: vi.fn().mockResolvedValue(true),
            send: vi.fn().mockResolvedValue(true)
        };

        mockMember = {
            id: 'user_host_1',
            displayName: 'Tester',
            permissions: {
                has: vi.fn().mockReturnValue(true)
            },
            user: { id: 'user_host_1', username: 'Tester', bot: false },
            voice: {
                channel: mockVoiceChannel,
                setChannel: vi.fn().mockResolvedValue(true)
            }
        };

        mockGuild = {
            id: 'g_vm_1',
            name: 'Voice Guild',
            channels: {
                create: vi.fn().mockResolvedValue(mockVoiceChannel)
            },
            roles: {
                everyone: { id: 'role_everyone' }
            }
        };
    });

    describe('/voice setup and info', () => {
        it('should setup category and hub channel', async () => {
            const mockCategory = { id: 'cat_1', name: '🔊 Temporary Voice' };
            const mockHub = { id: 'hub_1', name: '➕ Join to Create' };

            mockGuild.channels.create
                .mockResolvedValueOnce(mockCategory)
                .mockResolvedValueOnce(mockHub);

            const mockRun = vi.fn();
            db.prepare.mockReturnValue({ run: mockRun });

            const interaction = {
                guild: mockGuild,
                member: mockMember,
                options: { getSubcommand: () => 'setup' },
                deferReply: vi.fn().mockResolvedValue(true),
                editReply: vi.fn().mockResolvedValue(true)
            };

            await voiceCommand.execute(interaction);

            expect(mockGuild.channels.create).toHaveBeenCalledTimes(2);
            expect(mockRun).toHaveBeenCalledWith('hub_1', 'g_vm_1', 'cat_1');
            expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('successfully configured')
            }));
        });
    });

    describe('/voice commands', () => {
        it('should lock room for host', async () => {
            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ channelId: 'temp_vc_100', ownerId: 'user_host_1' })
            });

            const reply = vi.fn();
            const interaction = {
                guild: mockGuild,
                member: mockMember,
                user: mockMember.user,
                options: { getSubcommand: () => 'lock' },
                reply
            };

            await voiceCommand.execute(interaction);

            expect(mockVoiceChannel.permissionOverwrites.edit).toHaveBeenCalledWith(
                mockGuild.roles.everyone,
                { Connect: false }
            );
            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Room has been **locked**')
            }));
        });

        it('should rename room and save persistent name for host', async () => {
            const mockRun = vi.fn();
            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ channelId: 'temp_vc_100', ownerId: 'user_host_1' }),
                run: mockRun
            });

            const reply = vi.fn();
            const interaction = {
                guild: mockGuild,
                member: mockMember,
                user: mockMember.user,
                options: {
                    getSubcommand: () => 'name',
                    getString: () => 'Gaming Lounge'
                },
                reply
            };

            await voiceCommand.execute(interaction);

            expect(mockVoiceChannel.setName).toHaveBeenCalledWith('Gaming Lounge');
            expect(mockRun).toHaveBeenCalledWith(
                'user_host_1',
                'Gaming Lounge',
                undefined,
                expect.any(Number)
            );
            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Gaming Lounge')
            }));
        });

        it('should reject modification if user is not the host', async () => {
            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ channelId: 'temp_vc_100', ownerId: 'different_host' })
            });

            const reply = vi.fn();
            const interaction = {
                guild: mockGuild,
                member: mockMember,
                user: mockMember.user,
                options: { getSubcommand: () => 'lock' },
                reply
            };

            await voiceCommand.execute(interaction);

            expect(mockVoiceChannel.permissionOverwrites.edit).not.toHaveBeenCalled();
            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('You do not own this voice room')
            }));
        });
    });

    describe('voiceStateUpdate (Join to Create & Auto Delete)', () => {
        it('should create and route member when joining hub', async () => {
            // Mock config returning hubChannelId
            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ guildId: 'g_vm_1', hubChannelId: 'hub_channel_1' }),
                run: vi.fn()
            });

            const oldState = { channelId: null };
            const newState = {
                channelId: 'hub_channel_1',
                guild: mockGuild,
                member: mockMember
            };

            await voiceStateUpdateEvent.execute(oldState, newState);

            expect(mockGuild.channels.create).toHaveBeenCalled();
            expect(mockMember.voice.setChannel).toHaveBeenCalledWith('temp_vc_100');
        });

        it('should support multiple hubs concurrently', async () => {
            db.prepare.mockReturnValue({
                get: vi.fn().mockImplementation((id) => {
                    if (id === 'hub_channel_2') {
                        return { hubChannelId: 'hub_channel_2', categoryId: 'cat_2', guildId: 'g_vm_1' };
                    }
                    return null;
                }),
                run: vi.fn()
            });

            const oldState = { channelId: null };
            const newState = {
                channelId: 'hub_channel_2',
                guild: mockGuild,
                member: mockMember
            };

            await voiceStateUpdateEvent.execute(oldState, newState);

            expect(mockGuild.channels.create).toHaveBeenCalledWith(expect.objectContaining({
                parent: 'cat_2'
            }));
            expect(mockMember.voice.setChannel).toHaveBeenCalledWith('temp_vc_100');
        });

        it('should auto-delete room when empty', async () => {
            db.prepare.mockImplementation((sql) => {
                if (sql.includes('voice_hubs') || sql.includes('voice_guilds') || sql.includes('voicemaster_guilds')) {
                    return { get: vi.fn().mockReturnValue(null), run: vi.fn() };
                }
                return {
                    get: vi.fn().mockReturnValue({ channelId: 'temp_vc_100', ownerId: 'user_host_1' }),
                    run: vi.fn()
                };
            });

            const oldState = {
                channelId: 'temp_vc_100',
                channel: mockVoiceChannel,
                guild: mockGuild,
                member: mockMember
            };
            const newState = { channelId: null };

            // Empty channel (members.size === 0)
            mockVoiceChannel.members = new Map();

            await voiceStateUpdateEvent.execute(oldState, newState);

            expect(mockVoiceChannel.delete).toHaveBeenCalled();
        });
    });

    describe('interactionCreate button interactions', () => {
        it('should lock room when lock button is pressed by host', async () => {
            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ channelId: 'temp_vc_100', ownerId: 'user_host_1' })
            });

            const reply = vi.fn();
            const interaction = {
                guild: mockGuild,
                member: mockMember,
                user: mockMember.user,
                isButton: () => true,
                isModalSubmit: () => false,
                customId: 'vm_lock',
                reply
            };

            await interactionCreateEvent.execute(interaction);

            expect(mockVoiceChannel.permissionOverwrites.edit).toHaveBeenCalledWith(
                mockGuild.roles.everyone,
                { Connect: false }
            );
            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Room has been **locked**')
            }));
        });

        it('should emit voice updates on vm_modal_rename, vm_modal_limit, and vm_claim', async () => {
            const received = [];
            const unsub = subscribeVoiceUpdates('g_vm_1', (payload) => received.push(payload));

            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ channelId: 'temp_vc_100', ownerId: 'user_host_1' }),
                run: vi.fn()
            });

            await interactionCreateEvent.execute({
                guild: mockGuild,
                member: mockMember,
                user: mockMember.user,
                isModalSubmit: () => true,
                isButton: () => false,
                customId: 'vm_modal_rename',
                fields: { getTextInputValue: () => 'Renamed Room' },
                reply: vi.fn()
            });

            await interactionCreateEvent.execute({
                guild: mockGuild,
                member: mockMember,
                user: mockMember.user,
                isModalSubmit: () => true,
                isButton: () => false,
                customId: 'vm_modal_limit',
                fields: { getTextInputValue: () => '5' },
                reply: vi.fn()
            });

            // Claim when original owner left room
            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ channelId: 'temp_vc_100', ownerId: 'departed_owner' }),
                run: vi.fn()
            });

            await interactionCreateEvent.execute({
                guild: mockGuild,
                member: mockMember,
                user: mockMember.user,
                isModalSubmit: () => false,
                isButton: () => true,
                customId: 'vm_claim',
                reply: vi.fn()
            });

            unsub();
            expect(received).toHaveLength(3);
            expect(received[0]).toEqual({ guildId: 'g_vm_1', timestamp: expect.any(Number) });
        });
    });

    describe('Voice lifecycle pub/sub, pruning, and gateway reconciliation', () => {
        it('should subscribe, receive guild-scoped updates, and unsubscribe cleanly', () => {
            const listener = vi.fn();
            const unsubscribe = subscribeVoiceUpdates('g_vm_1', listener);

            emitVoiceUpdate('g_other');
            expect(listener).not.toHaveBeenCalled();

            emitVoiceUpdate('g_vm_1');
            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener).toHaveBeenCalledWith({
                guildId: 'g_vm_1',
                timestamp: expect.any(Number)
            });

            unsubscribe();
            emitVoiceUpdate('g_vm_1');
            expect(listener).toHaveBeenCalledTimes(1);
        });

        it('should safely delete room records and optionally emit voice update', () => {
            const listener = vi.fn();
            const unsub = subscribeVoiceUpdates('g_vm_1', listener);

            // Tolerates mocks without .run
            db.prepare.mockReturnValue({});
            expect(() => deleteVoiceRoomRecord('vc_orphan', 'g_vm_1')).not.toThrow();
            expect(listener).toHaveBeenCalledTimes(1);

            unsub();
        });

        it('should prune stale activeRooms missing from guild.channels.cache during /voice info', async () => {
            const deletedIds = [];
            db.prepare.mockImplementation((sql) => {
                if (sql.includes('SELECT * FROM voice_hubs')) {
                    return { all: vi.fn().mockReturnValue([{ hubChannelId: 'hub_1', guildId: 'g_vm_1', categoryId: 'cat_1' }]) };
                }
                if (sql.includes('SELECT * FROM voice_channels')) {
                    return {
                        all: vi.fn().mockReturnValue([
                            { channelId: 'vc_live', guildId: 'g_vm_1', ownerId: 'user_1' },
                            { channelId: 'vc_deleted_stale', guildId: 'g_vm_1', ownerId: 'user_2' }
                        ])
                    };
                }
                if (sql.startsWith('DELETE FROM voice_channels')) {
                    return { run: vi.fn((id) => deletedIds.push(id)) };
                }
                if (sql.startsWith('DELETE FROM voicemaster_channels')) {
                    return { run: vi.fn() };
                }
                return { get: vi.fn().mockReturnValue(null), run: vi.fn(), all: vi.fn().mockReturnValue([]) };
            });

            const guildWithCache = {
                ...mockGuild,
                channels: {
                    ...mockGuild.channels,
                    cache: new Map([
                        ['hub_1', { id: 'hub_1' }],
                        ['vc_live', { id: 'vc_live' }]
                    ])
                }
            };

            const listener = vi.fn();
            const unsub = subscribeVoiceUpdates('g_vm_1', listener);

            const reply = vi.fn();
            await voiceCommand.execute({
                guild: guildWithCache,
                member: { ...mockMember, voice: { channel: null } },
                user: mockMember.user,
                options: { getSubcommand: () => 'info' },
                reply
            });

            unsub();
            expect(deletedIds).toEqual(['vc_deleted_stale']);
            expect(listener).toHaveBeenCalledTimes(1);
            const embedJson = reply.mock.calls[0][0].embeds[0].toJSON();
            const roomsField = embedJson.fields.find(f => f.name.startsWith('Active Temporary Rooms'));
            expect(roomsField.name).toBe('Active Temporary Rooms (1)');
            expect(roomsField.value).toContain('vc_live');
            expect(roomsField.value).not.toContain('vc_deleted_stale');
        });

        it('should emit voice updates on /voice claim and /voice limit', async () => {
            const listener = vi.fn();
            const unsub = subscribeVoiceUpdates('g_vm_1', listener);

            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ channelId: 'temp_vc_100', ownerId: 'departed_host' }),
                run: vi.fn()
            });

            await voiceCommand.execute({
                guild: mockGuild,
                member: mockMember,
                user: mockMember.user,
                options: { getSubcommand: () => 'claim' },
                reply: vi.fn()
            });

            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ channelId: 'temp_vc_100', ownerId: 'user_host_1' }),
                run: vi.fn()
            });

            await voiceCommand.execute({
                guild: mockGuild,
                member: mockMember,
                user: mockMember.user,
                options: { getSubcommand: () => 'limit', getInteger: () => 4 },
                reply: vi.fn()
            });

            unsub();
            expect(listener).toHaveBeenCalledTimes(2);
        });

        it('should delete DB rows and emit when user leaves a temporary room already missing from guild.channels.cache', async () => {
            const deletedTables = [];
            db.prepare.mockImplementation((sql) => {
                if (sql.includes('voice_hubs') || sql.includes('voice_guilds') || sql.includes('voicemaster_guilds')) {
                    return { get: vi.fn().mockReturnValue(null) };
                }
                if (sql.startsWith('SELECT * FROM voice_channels')) {
                    return { get: vi.fn().mockReturnValue({ channelId: 'vc_vanished', guildId: 'g_vm_1', ownerId: 'user_host_1' }) };
                }
                if (sql.startsWith('DELETE FROM ')) {
                    return { run: vi.fn(() => deletedTables.push(sql)) };
                }
                return { get: vi.fn().mockReturnValue(null), run: vi.fn() };
            });

            const listener = vi.fn();
            const unsub = subscribeVoiceUpdates('g_vm_1', listener);

            const guildWithCache = {
                ...mockGuild,
                channels: {
                    ...mockGuild.channels,
                    cache: new Map([['some_other_ch', { id: 'some_other_ch' }]])
                }
            };

            await voiceStateUpdateEvent.execute(
                { channelId: 'vc_vanished', channel: null, guild: guildWithCache, member: mockMember },
                { channelId: null, guild: guildWithCache, member: mockMember }
            );

            unsub();
            expect(deletedTables).toHaveLength(2);
            expect(listener).toHaveBeenCalledTimes(1);
        });

        it('channelDelete should remove temporary room or hub DB rows and emit voice update', async () => {
            expect(channelDeleteEvent.name).toBe(Events.ChannelDelete);

            const listener = vi.fn();
            const unsub = subscribeVoiceUpdates('g_vm_1', listener);

            const executedSql = [];
            // 1) Deleting a tracked temporary voice room
            db.prepare.mockImplementation((sql) => {
                if (sql.startsWith('SELECT * FROM voice_channels')) {
                    return { get: vi.fn().mockReturnValue({ channelId: 'temp_vc_100', guildId: 'g_vm_1', ownerId: 'user_host_1' }) };
                }
                if (sql.startsWith('SELECT 1 FROM ')) {
                    return { get: vi.fn().mockReturnValue(null) };
                }
                if (sql.startsWith('DELETE FROM ')) {
                    return { run: vi.fn((id) => executedSql.push({ sql, id })) };
                }
                return { get: vi.fn().mockReturnValue(null), run: vi.fn() };
            });

            await channelDeleteEvent.execute({ id: 'temp_vc_100', guildId: 'g_vm_1' });
            expect(executedSql.map(e => e.sql)).toEqual([
                'DELETE FROM voice_channels WHERE channelId = ?',
                'DELETE FROM voicemaster_channels WHERE channelId = ?'
            ]);
            expect(listener).toHaveBeenCalledTimes(1);

            // 2) Deleting a configured hub channel
            executedSql.length = 0;
            db.prepare.mockImplementation((sql) => {
                if (sql.startsWith('SELECT * FROM ')) {
                    return { get: vi.fn().mockReturnValue(null) };
                }
                if (sql.startsWith('SELECT 1 FROM voice_hubs')) {
                    return { get: vi.fn().mockReturnValue({ 1: 1 }) };
                }
                if (sql.startsWith('DELETE FROM ')) {
                    return { run: vi.fn((id) => executedSql.push({ sql, id })) };
                }
                return { get: vi.fn().mockReturnValue(null), run: vi.fn() };
            });

            await channelDeleteEvent.execute({ id: 'hub_1', guild: { id: 'g_vm_1' } });
            expect(executedSql.map(e => e.sql)).toEqual([
                'DELETE FROM voice_hubs WHERE hubChannelId = ?',
                'DELETE FROM voice_guilds WHERE hubChannelId = ?',
                'DELETE FROM voicemaster_guilds WHERE hubChannelId = ?'
            ]);
            expect(listener).toHaveBeenCalledTimes(2);

            // 3) Deleting an unrelated channel should do nothing
            executedSql.length = 0;
            db.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(null), run: vi.fn() });
            await channelDeleteEvent.execute({ id: 'general_text_1', guildId: 'g_vm_1' });
            expect(executedSql).toHaveLength(0);
            expect(listener).toHaveBeenCalledTimes(2);

            unsub();
        });

        it('channelUpdate should emit voice update only when name, userLimit, or parentId changes on a tracked room or hub', async () => {
            expect(channelUpdateEvent.name).toBe(Events.ChannelUpdate);

            const listener = vi.fn();
            const unsub = subscribeVoiceUpdates('g_vm_1', listener);

            db.prepare.mockImplementation((sql) => {
                if (sql.startsWith('SELECT * FROM voice_channels')) {
                    return {
                        get: vi.fn((id) => id === 'temp_vc_100' ? { channelId: 'temp_vc_100', guildId: 'g_vm_1' } : null)
                    };
                }
                if (sql.startsWith('SELECT 1 FROM voice_hubs')) {
                    return {
                        get: vi.fn((id) => id === 'hub_1' ? { 1: 1 } : null)
                    };
                }
                return { get: vi.fn().mockReturnValue(null) };
            });

            // Unchanged relevant properties (e.g. bitrate changed only) -> no emit
            await channelUpdateEvent.execute(
                { id: 'temp_vc_100', guildId: 'g_vm_1', name: 'Room A', userLimit: 0, parentId: 'cat_1', bitrate: 64000 },
                { id: 'temp_vc_100', guildId: 'g_vm_1', name: 'Room A', userLimit: 0, parentId: 'cat_1', bitrate: 96000 }
            );
            expect(listener).not.toHaveBeenCalled();

            // Unrelated channel renamed -> no emit
            await channelUpdateEvent.execute(
                { id: 'unrelated_ch', guildId: 'g_vm_1', name: 'Old', userLimit: 0, parentId: 'cat_1' },
                { id: 'unrelated_ch', guildId: 'g_vm_1', name: 'New', userLimit: 0, parentId: 'cat_1' }
            );
            expect(listener).not.toHaveBeenCalled();

            // Tracked temporary room renamed -> emits
            await channelUpdateEvent.execute(
                { id: 'temp_vc_100', guildId: 'g_vm_1', name: 'Room A', userLimit: 0, parentId: 'cat_1' },
                { id: 'temp_vc_100', guildId: 'g_vm_1', name: 'Room B', userLimit: 0, parentId: 'cat_1' }
            );
            expect(listener).toHaveBeenCalledTimes(1);

            // Tracked temporary room userLimit changed -> emits
            await channelUpdateEvent.execute(
                { id: 'temp_vc_100', guildId: 'g_vm_1', name: 'Room B', userLimit: 0, parentId: 'cat_1' },
                { id: 'temp_vc_100', guildId: 'g_vm_1', name: 'Room B', userLimit: 4, parentId: 'cat_1' }
            );
            expect(listener).toHaveBeenCalledTimes(2);

            // Hub channel parentId changed -> emits
            await channelUpdateEvent.execute(
                { id: 'hub_1', guildId: 'g_vm_1', name: 'Join', userLimit: 0, parentId: 'cat_1' },
                { id: 'hub_1', guildId: 'g_vm_1', name: 'Join', userLimit: 0, parentId: 'cat_2' }
            );
            expect(listener).toHaveBeenCalledTimes(3);

            unsub();
        });

        it('ready event and reconcileGuildVoiceRooms should prune missing and empty rooms while keeping occupied ones', async () => {
            expect(readyEvent.name).toBe(Events.ClientReady);
            expect(readyEvent.once).toBe(true);

            const deletedChannelIds = [];
            db.prepare.mockImplementation((sql) => {
                if (sql === 'SELECT * FROM voice_channels WHERE guildId = ?') {
                    return {
                        all: vi.fn().mockReturnValue([
                            { channelId: 'vc_missing', guildId: 'g_vm_1', ownerId: 'u1' },
                            { channelId: 'vc_empty', guildId: 'g_vm_1', ownerId: 'u2' },
                            { channelId: 'vc_occupied', guildId: 'g_vm_1', ownerId: 'u3' }
                        ])
                    };
                }
                if (sql === 'SELECT * FROM voicemaster_channels WHERE guildId = ?') {
                    return {
                        all: vi.fn().mockReturnValue([
                            { channelId: 'vc_vm_only_missing', guildId: 'g_vm_1', ownerId: 'u4' }
                        ])
                    };
                }
                if (sql === 'DELETE FROM voice_channels WHERE channelId = ?') {
                    return { run: vi.fn((id) => deletedChannelIds.push(id)) };
                }
                if (sql === 'DELETE FROM voicemaster_channels WHERE channelId = ?') {
                    return { run: vi.fn() };
                }
                return { all: vi.fn().mockReturnValue([]), run: vi.fn() };
            });

            const emptyRoom = {
                id: 'vc_empty',
                members: new Map(),
                delete: vi.fn().mockResolvedValue(true)
            };
            const occupiedRoom = {
                id: 'vc_occupied',
                members: new Map([['u3', { id: 'u3' }]]),
                delete: vi.fn().mockResolvedValue(true)
            };

            const channelCollection = new Map([
                ['vc_empty', emptyRoom],
                ['vc_occupied', occupiedRoom]
            ]);

            const guild = {
                id: 'g_vm_1',
                channels: {
                    cache: channelCollection,
                    fetch: vi.fn().mockResolvedValue(channelCollection)
                }
            };

            const listener = vi.fn();
            const unsub = subscribeVoiceUpdates('g_vm_1', listener);

            const mockClient = {
                guilds: {
                    cache: new Map([['g_vm_1', guild]])
                }
            };

            await readyEvent.execute(mockClient);

            unsub();

            expect(guild.channels.fetch).toHaveBeenCalledTimes(1);
            expect(deletedChannelIds).toEqual(['vc_missing', 'vc_empty', 'vc_vm_only_missing']);
            expect(emptyRoom.delete).toHaveBeenCalledWith('Temporary voice room empty on startup');
            expect(occupiedRoom.delete).not.toHaveBeenCalled();
            expect(listener).toHaveBeenCalledTimes(1);
        });

        it('reconcileGuildVoiceRooms should not emit when all tracked rooms are still occupied', async () => {
            db.prepare.mockImplementation((sql) => {
                if (sql === 'SELECT * FROM voice_channels WHERE guildId = ?') {
                    return { all: vi.fn().mockReturnValue([{ channelId: 'vc_active', guildId: 'g_vm_1', ownerId: 'u1' }]) };
                }
                return { all: vi.fn().mockReturnValue([]), run: vi.fn() };
            });

            const activeRoom = {
                id: 'vc_active',
                members: new Map([['u1', { id: 'u1' }]]),
                delete: vi.fn()
            };

            const listener = vi.fn();
            const unsub = subscribeVoiceUpdates('g_vm_1', listener);

            const cleaned = await reconcileGuildVoiceRooms({
                id: 'g_vm_1',
                channels: { cache: new Map([['vc_active', activeRoom]]) }
            });

            unsub();
            expect(cleaned).toBe(0);
            expect(activeRoom.delete).not.toHaveBeenCalled();
            expect(listener).not.toHaveBeenCalled();
        });
    });
});
