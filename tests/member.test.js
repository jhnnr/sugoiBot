import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Member } from '../lib/classes/Member.js';
import db from '../lib/database.js';

vi.mock('../lib/database.js', () => ({
    default: {
        prepare: vi.fn()
    }
}));

describe('Member', () => {
    let mockGuildMember;
    let member;

    beforeEach(() => {
        vi.clearAllMocks();
        mockGuildMember = {
            id: '123',
            guild: {
                id: '456',
                roles: {
                    fetch: vi.fn()
                }
            },
            roles: {
                add: vi.fn()
            }
        };
        member = new Member(mockGuildMember);
    });

    it('getXP should return default if no row found', () => {
        db.prepare.mockReturnValue({
            get: vi.fn().mockReturnValue(undefined)
        });

        expect(member.getXP()).toEqual({ xp: 0, level: 1 });
    });

    it('getXP should return xp and level if row found', () => {
        db.prepare.mockReturnValue({
            get: vi.fn().mockReturnValue({ xp: 10, level: 2 })
        });

        expect(member.getXP()).toEqual({ xp: 10, level: 2 });
    });

    it('getBalance should return 0 if no row found', () => {
        db.prepare.mockReturnValue({
            get: vi.fn().mockReturnValue(undefined)
        });

        expect(member.getBalance()).toBe(0);
    });

    it('addBalance should update balance', () => {
        const mockRun = vi.fn();
        db.prepare.mockReturnValue({
            get: vi.fn().mockReturnValue({ balance: 100, lastDaily: 0, lastWork: 0 }),
            run: mockRun
        });

        const newBalance = member.addBalance(50);
        expect(newBalance).toBe(150);
        expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO currency'));
        expect(mockRun).toHaveBeenCalledWith('123', 150, 0, 0);
    });

    it('getWarnings should query warnings table for member and guild', () => {
        const mockWarnings = [{ id: 1, reason: 'Spamming' }];
        db.prepare.mockReturnValue({
            all: vi.fn().mockReturnValue(mockWarnings)
        });

        const warnings = member.getWarnings();
        expect(warnings).toEqual(mockWarnings);
        expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM warnings WHERE userId = ? AND guildId = ?'));
    });

    it('addWarning should insert warning into warnings table', () => {
        const mockRun = vi.fn();
        db.prepare.mockReturnValue({
            run: mockRun
        });

        member.addWarning('Inappropriate language', 'mod999');
        expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO warnings'));
        expect(mockRun).toHaveBeenCalledWith('123', '456', 'Inappropriate language', 'mod999');
    });
});
