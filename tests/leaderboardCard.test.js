import { describe, it, expect } from 'vitest';
import { generateLeaderboardCard } from '../lib/utils/leaderboardCard.js';

describe('Leaderboard Card Image Generator', () => {
    it('should generate a valid PNG buffer with header and player rows', async () => {
        const mockGuild = { name: 'Epic Gamers Guild' };
        const mockPlayers = [
            {
                rank: 1,
                user: { username: 'Naruto', displayAvatarURL: () => null },
                xp: 1500,
                level: 8
            },
            {
                rank: 2,
                user: { username: 'Sasuke', displayAvatarURL: () => null },
                xp: 1200,
                level: 7
            },
            {
                rank: 3,
                user: { username: 'Sakura', displayAvatarURL: () => null },
                xp: 850,
                level: 5
            }
        ];

        const buffer = await generateLeaderboardCard(mockGuild, mockPlayers);
        expect(buffer).toBeInstanceOf(Buffer);
        expect(buffer.length).toBeGreaterThan(1000);

        // Check PNG magic bytes (0x89 0x50 0x4E 0x47)
        expect(buffer[0]).toBe(0x89);
        expect(buffer[1]).toBe(0x50);
        expect(buffer[2]).toBe(0x4E);
        expect(buffer[3]).toBe(0x47);
    });

    it('should generate empty placeholder leaderboard without crashing', async () => {
        const mockGuild = { name: 'Empty Guild' };
        const buffer = await generateLeaderboardCard(mockGuild, []);
        expect(buffer).toBeInstanceOf(Buffer);
        expect(buffer.length).toBeGreaterThan(1000);
    });

    it('should render leaderboard when guild iconURL is present', async () => {
        const mockGuild = {
            name: 'Pro Guild',
            iconURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
        };
        const buffer = await generateLeaderboardCard(mockGuild, [
            { rank: 1, user: { username: 'Ace' }, xp: 200, level: 2 }
        ]);
        expect(buffer).toBeInstanceOf(Buffer);
        expect(buffer.length).toBeGreaterThan(1000);
    });
});
