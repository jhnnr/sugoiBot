import { describe, it, expect, vi, beforeEach } from 'vitest';
import banCommand from '../modules/moderation/commands/ban.js';
import kickCommand from '../modules/moderation/commands/kick.js';
import warnCommand from '../modules/moderation/commands/warn.js';
import clearCommand from '../modules/moderation/commands/clear.js';
import db from '../lib/database.js';
import { loggingService } from '../lib/bot/loggingService.js';

vi.mock('../lib/database.js', () => ({
    default: {
        prepare: vi.fn(),
    },
}));

vi.mock('../lib/bot/loggingService.js', () => ({
    loggingService: {
        log: vi.fn().mockResolvedValue(true),
    },
}));

describe('Moderation Module', () => {
    let mockTargetMember;
    let mockTargetUser;
    let mockGuild;
    let mockInteraction;

    beforeEach(() => {
        vi.clearAllMocks();
        mockTargetUser = { id: 't200', tag: 'BadUser#1234' };
        mockTargetMember = {
            id: 't200',
            user: mockTargetUser,
            bannable: true,
            kickable: true,
            ban: vi.fn().mockResolvedValue(true),
            kick: vi.fn().mockResolvedValue(true),
            guild: { id: 'g200' }
        };
        mockGuild = { id: 'g200', name: 'Test Guild' };
        mockInteraction = {
            guild: mockGuild,
            user: { id: 'mod1', tag: 'Mod#0001' },
            options: {
                getMember: vi.fn().mockReturnValue(mockTargetMember),
                getUser: vi.fn().mockReturnValue(mockTargetUser),
                getString: vi.fn().mockReturnValue('Rule violation'),
                getInteger: vi.fn().mockReturnValue(10),
            },
            reply: vi.fn().mockResolvedValue(true),
        };
    });

    describe('/ban', () => {
        it('should successfully ban target and dispatch audit log', async () => {
            await banCommand.execute(mockInteraction);

            expect(mockTargetMember.ban).toHaveBeenCalledWith({ reason: 'Rule violation' });
            expect(mockInteraction.reply).toHaveBeenCalledWith({
                content: expect.stringContaining('Successfully banned BadUser#1234')
            });
            expect(loggingService.log).toHaveBeenCalledWith(
                mockGuild,
                expect.objectContaining({
                    title: 'Member Banned',
                    eventType: 'log_events_moderation'
                })
            );
        });

        it('should reject ban if target is not bannable', async () => {
            mockTargetMember.bannable = false;

            await banCommand.execute(mockInteraction);

            expect(mockTargetMember.ban).not.toHaveBeenCalled();
            expect(mockInteraction.reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('I cannot ban this user'),
                ephemeral: true
            }));
        });
    });

    describe('/kick', () => {
        it('should successfully kick target and dispatch audit log', async () => {
            await kickCommand.execute(mockInteraction);

            expect(mockTargetMember.kick).toHaveBeenCalledWith('Rule violation');
            expect(mockInteraction.reply).toHaveBeenCalledWith({
                content: expect.stringContaining('Successfully kicked BadUser#1234')
            });
            expect(loggingService.log).toHaveBeenCalledWith(
                mockGuild,
                expect.objectContaining({
                    title: 'Member Kicked',
                    eventType: 'log_events_moderation'
                })
            );
        });

        it('should reject kick if target is not kickable', async () => {
            mockTargetMember.kickable = false;

            await kickCommand.execute(mockInteraction);

            expect(mockTargetMember.kick).not.toHaveBeenCalled();
            expect(mockInteraction.reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('I cannot kick this user'),
                ephemeral: true
            }));
        });
    });

    describe('/warn', () => {
        it('should insert warning and dispatch audit log', async () => {
            const mockRun = vi.fn();
            db.prepare.mockReturnValue({
                run: mockRun,
                all: vi.fn().mockReturnValue([{ id: 1, reason: 'Rule violation' }])
            });

            await warnCommand.execute(mockInteraction);

            expect(mockRun).toHaveBeenCalledWith('t200', 'g200', 'Rule violation', 'mod1');
            expect(mockInteraction.reply).toHaveBeenCalledWith({
                content: expect.stringContaining('Successfully warned BadUser#1234')
            });
            expect(loggingService.log).toHaveBeenCalledWith(
                mockGuild,
                expect.objectContaining({
                    title: 'Member Warned',
                    eventType: 'log_events_moderation'
                })
            );
        });
    });

    describe('/clear', () => {
        it('should bulk delete requested messages', async () => {
            const mockBulkDelete = vi.fn().mockResolvedValue(new Map([[1, {}], [2, {}]]));
            mockInteraction.channel = {
                bulkDelete: mockBulkDelete
            };

            await clearCommand.execute(mockInteraction);

            expect(mockBulkDelete).toHaveBeenCalledWith(10, true);
            expect(mockInteraction.reply).toHaveBeenCalledWith({
                content: expect.stringContaining('Successfully deleted 2 messages.'),
                ephemeral: true
            });
        });
    });

    describe('/testlog', () => {
        it('should dispatch test embed to configured channel', async () => {
            const { default: testlogCommand } = await import('../modules/moderation/commands/testlog.js');
            const mockSend = vi.fn().mockResolvedValue(true);
            const mockLogChannel = {
                id: 'log_999',
                send: mockSend,
                permissionsFor: () => ({
                    has: () => true
                })
            };

            const interaction = {
                guild: {
                    id: 'g200',
                    name: 'Test Guild',
                    members: { me: {} },
                    channels: {
                        cache: new Map([['log_999', mockLogChannel]]),
                        fetch: vi.fn().mockResolvedValue(mockLogChannel)
                    }
                },
                user: { tag: 'Admin#0001' },
                reply: vi.fn().mockResolvedValue(true)
            };

            // Mock SettingsManager.getGuild
            const { SettingsManager } = await import('../lib/settings.js');
            const spy = vi.spyOn(SettingsManager, 'getGuild').mockReturnValue('log_999');

            await testlogCommand.execute(interaction);

            expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
                embeds: expect.any(Array)
            }));
            expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Successfully dispatched a test audit log')
            }));

            spy.mockRestore();
        });
    });
});
