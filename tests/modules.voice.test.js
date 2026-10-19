import { describe, it, expect, vi, beforeEach } from 'vitest';
import voiceCommand from '../modules/voice/commands/voice.js';
import voiceStateUpdateEvent from '../modules/voice/events/voiceStateUpdate.js';
import interactionCreateEvent from '../modules/voice/events/interactionCreate.js';
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
    });
});
