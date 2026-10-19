import { describe, it, expect } from 'vitest';
import { formatTimestamp, capitalize } from '../lib/utils/formatters.js';

describe('Formatters', () => {
    it('formatTimestamp should return discord timestamp format', () => {
        const date = new Date(1700000000000);
        expect(formatTimestamp(date)).toBe('<t:1700000000:R>');
    });

    it('capitalize should capitalize the first letter', () => {
        expect(capitalize('hello')).toBe('Hello');
        expect(capitalize('world')).toBe('World');
        expect(capitalize('a')).toBe('A');
    });
});
