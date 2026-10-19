import { describe, it, expect, vi, beforeEach } from 'vitest';
import balanceCommand from '../modules/economy/commands/balance.js';
import dailyCommand from '../modules/economy/commands/daily.js';
import workCommand from '../modules/economy/commands/work.js';
import coinflipCommand from '../modules/economy/commands/coinflip.js';
import db from '../lib/database.js';

vi.mock('../lib/database.js', () => ({
    default: {
        prepare: vi.fn(),
    },
}));

describe('Economy Module', () => {
    let mockMember;
    let mockUser;

    beforeEach(() => {
        vi.clearAllMocks();
        mockUser = { id: 'u100', tag: 'Player#0001' };
        mockMember = {
            id: 'u100',
            guild: { id: 'g100' },
            user: mockUser,
        };
    });

    describe('/balance', () => {
        it('should return the balance of the requesting user', async () => {
            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ balance: 250, lastDaily: 0, lastWork: 0 })
            });

            const reply = vi.fn();
            const interaction = {
                user: mockUser,
                guild: { id: 'g100' },
                options: {
                    getMember: vi.fn().mockReturnValue(mockMember),
                    getUser: vi.fn().mockReturnValue(mockUser)
                },
                reply
            };

            await balanceCommand.execute(interaction);
            expect(reply).toHaveBeenCalledWith({
                content: expect.stringContaining('Your balance is **250** coins.')
            });
        });
    });

    describe('/daily', () => {
        it('should grant daily reward when cooldown has passed', async () => {
            // Last claimed 25 hours ago
            const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
            const mockRun = vi.fn();

            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ balance: 100, lastDaily: twentyFiveHoursAgo, lastWork: 0 }),
                run: mockRun
            });

            const reply = vi.fn();
            const interaction = {
                member: mockMember,
                reply
            };

            await dailyCommand.execute(interaction);
            expect(reply).toHaveBeenCalledWith({
                content: expect.stringContaining('claimed your daily reward')
            });
            expect(mockRun).toHaveBeenCalled();
        });

        it('should reject claim when still on cooldown', async () => {
            // Claimed 1 hour ago
            const oneHourAgo = Date.now() - 60 * 60 * 1000;

            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ balance: 100, lastDaily: oneHourAgo, lastWork: 0 })
            });

            const reply = vi.fn();
            const interaction = {
                member: mockMember,
                reply
            };

            await dailyCommand.execute(interaction);
            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('already claimed your daily reward'),
                ephemeral: true
            }));
        });
    });

    describe('/work', () => {
        it('should reward coins when work is available', async () => {
            const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
            const mockRun = vi.fn();

            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ balance: 50, lastDaily: 0, lastWork: twoHoursAgo }),
                run: mockRun
            });

            const reply = vi.fn();
            const interaction = {
                member: mockMember,
                reply
            };

            await workCommand.execute(interaction);
            expect(reply).toHaveBeenCalledWith({
                content: expect.stringContaining('You worked')
            });
            expect(mockRun).toHaveBeenCalled();
        });
    });

    describe('/coinflip', () => {
        it('should reject bet if balance is insufficient', async () => {
            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ balance: 20, lastDaily: 0, lastWork: 0 })
            });

            const reply = vi.fn();
            const interaction = {
                member: mockMember,
                options: {
                    getInteger: vi.fn().mockReturnValue(50),
                    getString: vi.fn().mockReturnValue('heads')
                },
                reply
            };

            await coinflipCommand.execute(interaction);
            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining("don't have enough coins"),
                ephemeral: true
            }));
        });

        it('should execute bet and return an embed response when balance is sufficient', async () => {
            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ balance: 100, lastDaily: 0, lastWork: 0 }),
                run: vi.fn()
            });

            const reply = vi.fn();
            const interaction = {
                member: mockMember,
                options: {
                    getInteger: vi.fn().mockReturnValue(25),
                    getString: vi.fn().mockReturnValue('heads')
                },
                reply
            };

            await coinflipCommand.execute(interaction);
            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                embeds: expect.any(Array)
            }));
        });
    });
});
