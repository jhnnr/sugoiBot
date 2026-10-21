import { describe, it, expect, vi, beforeEach } from 'vitest';
import rankCommand from '../modules/xp/commands/rank.js';
import leaderboardCommand from '../modules/xp/commands/leaderboard.js';
import messageCreateEvent from '../modules/xp/events/messageCreate.js';
import voiceStateUpdateEvent from '../modules/xp/events/voiceStateUpdate.js';
import db from '../lib/database.js';

vi.mock('../lib/database.js', () => ({
    default: {
        prepare: vi.fn(),
    },
}));

describe('XP Module', () => {
    let mockMember;
    let mockUser;
    let mockGuild;

    beforeEach(() => {
        vi.clearAllMocks();
        mockUser = { id: 'u300', tag: 'UserXP#1111', bot: false };
        mockGuild = { id: 'g300', name: 'XP Guild' };
        mockMember = {
            id: 'u300',
            user: mockUser,
            guild: mockGuild,
            send: vi.fn().mockResolvedValue(true)
        };
    });

    describe('/rank', () => {
        it('should generate a rank card image attachment for user', async () => {
            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ xp: 120, level: 3 })
            });

            const reply = vi.fn();
            const interaction = {
                member: mockMember,
                guild: mockGuild,
                user: mockUser,
                options: {
                    getMember: vi.fn().mockReturnValue(mockMember),
                    getUser: vi.fn().mockReturnValue(mockUser)
                },
                reply
            };

            await rankCommand.execute(interaction);
            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                files: expect.any(Array)
            }));
            const files = reply.mock.calls[0][0].files;
            expect(files.length).toBe(1);
            expect(files[0].name).toBe('rank.png');
        });
    });

    describe('/leaderboard', () => {
        it('should display leaderboard embed when users have XP', async () => {
            db.prepare.mockReturnValue({
                all: vi.fn().mockReturnValue([
                    { userId: 'u1', xp: 500, level: 5 },
                    { userId: 'u2', xp: 300, level: 3 }
                ])
            });

            const reply = vi.fn();
            const interaction = {
                guild: mockGuild,
                options: {
                    getInteger: vi.fn().mockReturnValue(10)
                },
                reply
            };

            await leaderboardCommand.execute(interaction);
            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                files: expect.any(Array)
            }));
            const files = reply.mock.calls[0][0].files;
            expect(files.length).toBe(1);
            expect(files[0].name).toBe('leaderboard.png');
        });

        it('should return helpful message when no users have XP yet', async () => {
            db.prepare.mockReturnValue({
                all: vi.fn().mockReturnValue([])
            });

            const reply = vi.fn();
            const interaction = {
                guild: mockGuild,
                options: {
                    getInteger: vi.fn().mockReturnValue(10)
                },
                reply
            };

            await leaderboardCommand.execute(interaction);
            expect(reply).toHaveBeenCalledWith({
                content: expect.stringContaining('No users have earned XP yet'),
                ephemeral: true
            });
        });
    });

    describe('messageCreate event', () => {
        it('should ignore bot messages', async () => {
            const message = {
                author: { bot: true },
                guild: mockGuild,
                member: mockMember
            };

            await messageCreateEvent.execute(message);
            expect(db.prepare).not.toHaveBeenCalled();
        });

        it('should award XP to non-bot users', async () => {
            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ xp: 50, level: 1 }),
                run: vi.fn()
            });

            const message = {
                author: { bot: false, tag: 'UserXP#1111' },
                guild: mockGuild,
                member: mockMember,
                reply: vi.fn()
            };

            await messageCreateEvent.execute(message);
            expect(db.prepare).toHaveBeenCalled();
        });
    });

    describe('voiceStateUpdate event', () => {
        it('should ignore bot voice updates', async () => {
            const oldState = { channelId: null, member: { user: { bot: true } } };
            const newState = { channelId: 'v1', member: { user: { bot: true } } };

            await voiceStateUpdateEvent.execute(oldState, newState);
            expect(db.prepare).not.toHaveBeenCalled();
        });

        it('should log when a member is moved by another user', async () => {
            const mockEntry = {
                createdTimestamp: Date.now() - 500,
                executor: '<@mod1>'
            };
            mockGuild.members = {
                me: {
                    permissions: {
                        has: vi.fn().mockReturnValue(true)
                    }
                }
            };
            mockGuild.fetchAuditLogs = vi.fn().mockResolvedValue({
                entries: { first: () => mockEntry }
            });

            const oldState = { channelId: 'vc1', channel: { name: 'Room 1' }, member: mockMember };
            const newState = { channelId: 'vc2', channel: { name: 'Room 2' }, member: mockMember };

            const { loggingService } = await import('../lib/bot/loggingService.js');
            const logSpy = vi.spyOn(loggingService, 'log').mockResolvedValue(true);

            await voiceStateUpdateEvent.execute(oldState, newState);

            expect(logSpy).toHaveBeenCalledWith(
                mockGuild,
                expect.objectContaining({
                    description: expect.stringContaining('was moved from voice channel **Room 1** to **Room 2** by <@mod1>')
                })
            );
            logSpy.mockRestore();
        });

        it('should award voice XP on disconnect when user was in voice', async () => {
            const { voiceCollection } = await import('../modules/xp/events/voiceStateUpdate.js');
            const mockRun = vi.fn();
            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ xp: 10, level: 1 }),
                run: mockRun
            });

            // Simulate session in voiceCollection for 2 minutes
            const sessionKey = `${mockGuild.id}_${mockMember.id}`;
            voiceCollection.set(sessionKey, {
                guildId: mockGuild.id,
                userId: mockMember.id,
                channelId: 'vc1',
                joinedAt: Date.now() - 120000,
                lastAwardedAt: Date.now() - 120000
            });

            const oldState = { channelId: 'vc1', channel: { name: 'Room 1' }, member: mockMember, deaf: false, selfDeaf: false };
            const newState = { channelId: null, member: mockMember };

            await voiceStateUpdateEvent.execute(oldState, newState);

            expect(mockRun).toHaveBeenCalled();
            expect(voiceCollection.has(sessionKey)).toBe(false);
        });
    });

    describe('/setreward', () => {
        it('should add a level role reward', async () => {
            const { default: setrewardCommand } = await import('../modules/xp/commands/setreward.js');
            const { SettingsManager } = await import('../lib/settings.js');
            const setSpy = vi.spyOn(SettingsManager, 'setGuildJson').mockReturnValue();
            const getSpy = vi.spyOn(SettingsManager, 'getGuildJson').mockReturnValue({});

            const reply = vi.fn();
            const interaction = {
                guild: mockGuild,
                options: {
                    getSubcommand: () => 'add',
                    getInteger: () => 5,
                    getRole: () => ({ id: 'role_lvl5', toString: () => '<@&role_lvl5>' })
                },
                reply
            };

            await setrewardCommand.execute(interaction);

            expect(setSpy).toHaveBeenCalledWith('g300', 'role_rewards', { '5': 'role_lvl5' });
            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Configured role reward: Members reaching **Level 5**')
            }));

            setSpy.mockRestore();
            getSpy.mockRestore();
        });

        it('should list configured role rewards', async () => {
            const { default: setrewardCommand } = await import('../modules/xp/commands/setreward.js');
            const { SettingsManager } = await import('../lib/settings.js');
            const getSpy = vi.spyOn(SettingsManager, 'getGuildJson').mockReturnValue({ '5': 'role_5', '10': 'role_10' });

            const reply = vi.fn();
            const interaction = {
                guild: mockGuild,
                options: {
                    getSubcommand: () => 'list'
                },
                reply
            };

            await setrewardCommand.execute(interaction);

            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                embeds: expect.any(Array)
            }));

            getSpy.mockRestore();
        });
    });
});
