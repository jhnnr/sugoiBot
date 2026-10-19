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
});
