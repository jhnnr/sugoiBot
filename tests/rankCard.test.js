import { describe, it, expect } from 'vitest';
import { generateRankCard } from '../lib/utils/rankCard.js';

describe('Rank Card Image Generator', () => {
    it('should generate a valid PNG buffer with avatar fallback', async () => {
        const mockUser = {
            username: 'Saitama',
            displayAvatarURL: () => null // triggers fallback avatar
        };

        const rankData = {
            xp: 250,
            level: 4
        };

        const neededXP = 500;

        const buffer = await generateRankCard(mockUser, rankData, neededXP);
        expect(buffer).toBeInstanceOf(Buffer);
        expect(buffer.length).toBeGreaterThan(1000);

        // Check PNG magic number (0x89 0x50 0x4E 0x47)
        expect(buffer[0]).toBe(0x89);
        expect(buffer[1]).toBe(0x50);
        expect(buffer[2]).toBe(0x4E);
        expect(buffer[3]).toBe(0x47);
    });

    it('should generate a valid PNG buffer when user avatar URL is present', async () => {
        const mockUser = {
            username: 'Genos',
            displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png'
        };

        const rankData = {
            xp: 75,
            level: 1
        };

        const buffer = await generateRankCard(mockUser, rankData, 100);
        expect(buffer).toBeInstanceOf(Buffer);
        expect(buffer.length).toBeGreaterThan(1000);
    });
});
