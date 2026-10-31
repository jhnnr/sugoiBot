import { describe, it, expect, vi } from 'vitest';
import pingCommand from '../modules/general/commands/ping.js';

describe('General Module', () => {
    describe('/ping command', () => {
        it('should have valid SlashCommandBuilder data', () => {
            expect(pingCommand.data.name).toBe('ping');
            expect(pingCommand.data.description).toBeDefined();
        });

        it('should reply with latency calculation', async () => {
            const mockReply = vi.fn();
            const now = Date.now();
            const mockInteraction = {
                createdTimestamp: now - 50,
                reply: mockReply,
            };

            await pingCommand.execute(mockInteraction);

            expect(mockReply).toHaveBeenCalledTimes(1);
            const replyMsg = mockReply.mock.calls[0][0];
            expect(replyMsg).toContain('Pong!');
            expect(replyMsg).toContain('Latency is');
        });
    });

    describe('/userinfo command', () => {
        it('should have valid SlashCommandBuilder data', async () => {
            const { default: userinfoCommand } = await import('../modules/general/commands/userinfo.js');
            expect(userinfoCommand.data.name).toBe('userinfo');
            expect(userinfoCommand.data.description).toBeDefined();
        });

        it('should return telemetry embed for user', async () => {
            const { default: userinfoCommand } = await import('../modules/general/commands/userinfo.js');
            const mockReply = vi.fn();
            const mockGuild = { id: 'g1', ownerId: 'owner1', name: 'Test Guild' };
            const mockTargetUser = {
                id: 'target1',
                username: 'targetUser',
                tag: 'targetUser#0001',
                createdTimestamp: Date.now() - 1000000,
                displayAvatarURL: vi.fn().mockReturnValue('https://cdn.discordapp.com/avatars/target1/avatar.png')
            };
            const mockTargetMember = {
                id: 'target1',
                user: mockTargetUser,
                guild: mockGuild,
                nickname: 'TargetNick',
                joinedTimestamp: Date.now() - 500000,
                roles: {
                    cache: new Map([['r1', { id: 'r1', position: 10, toString: () => '<@&r1>' }]]),
                    highest: { id: 'r1', name: 'Admin' }
                },
                permissions: { has: vi.fn().mockReturnValue(true) },
                displayHexColor: '#5865F2'
            };

            const mockInteraction = {
                guild: mockGuild,
                user: { tag: 'Admin#0001' },
                member: {
                    id: 'owner1',
                    guild: mockGuild,
                    permissions: { has: vi.fn().mockReturnValue(true) },
                    roles: { cache: new Map() }
                },
                options: {
                    getUser: vi.fn().mockReturnValue(mockTargetUser),
                    getMember: vi.fn().mockReturnValue(mockTargetMember)
                },
                reply: mockReply
            };

            await userinfoCommand.execute(mockInteraction);

            expect(mockReply).toHaveBeenCalledWith(expect.objectContaining({
                embeds: expect.any(Array)
            }));
            const embed = mockReply.mock.calls[0][0].embeds[0];
            expect(embed.data.title).toContain('User Info');
        });
    });
});
