import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { loadCommands } from '../handlers/commandHandler.js';
import { loadEvents } from '../handlers/eventHandler.js';
import { loadModules } from '../handlers/moduleHandler.js';

describe('Handlers', () => {
    let mockClient;

    beforeEach(() => {
        mockClient = {
            commands: new Map(),
            modules: new Map(),
            on: vi.fn(),
            once: vi.fn(),
        };
    });

    describe('commandHandler', () => {
        it('should do nothing if commands directory does not exist', async () => {
            await loadCommands(mockClient, path.join(process.cwd(), 'non-existent-module'));
            expect(mockClient.commands.size).toBe(0);
        });

        it('should load commands from a valid module commands directory', async () => {
            const generalDir = path.join(process.cwd(), 'modules', 'general');
            await loadCommands(mockClient, generalDir);
            expect(mockClient.commands.has('ping')).toBe(true);
            const pingCmd = mockClient.commands.get('ping');
            expect(pingCmd.data.name).toBe('ping');
            expect(typeof pingCmd.execute).toBe('function');
        });
    });

    describe('eventHandler', () => {
        it('should do nothing if events directory does not exist', async () => {
            await loadEvents(mockClient, path.join(process.cwd(), 'non-existent-module'));
            expect(mockClient.on).not.toHaveBeenCalled();
            expect(mockClient.once).not.toHaveBeenCalled();
        });

        it('should load once and on events from a module', async () => {
            const coreDir = path.join(process.cwd(), 'modules', 'core');
            await loadEvents(mockClient, coreDir);
            // ready is once, interactionCreate, messageDelete, guildMemberAdd, guildMemberRemove, userUpdate, guildMemberUpdate are on
            expect(mockClient.once).toHaveBeenCalledWith('clientReady', expect.any(Function));
            expect(mockClient.on).toHaveBeenCalledWith('interactionCreate', expect.any(Function));
            expect(mockClient.on).toHaveBeenCalledWith('messageDelete', expect.any(Function));
            expect(mockClient.on).toHaveBeenCalledWith('guildMemberAdd', expect.any(Function));
            expect(mockClient.on).toHaveBeenCalledWith('guildMemberRemove', expect.any(Function));
            expect(mockClient.on).toHaveBeenCalledWith('userUpdate', expect.any(Function));
            expect(mockClient.on).toHaveBeenCalledWith('guildMemberUpdate', expect.any(Function));
            expect(mockClient.on).toHaveBeenCalledWith('channelCreate', expect.any(Function));
            expect(mockClient.on).toHaveBeenCalledWith('channelDelete', expect.any(Function));
        });
    });

    describe('moduleHandler', () => {
        it('should load all existing modules and register metadata', async () => {
            await loadModules(mockClient);
            expect(mockClient.modules.has('core')).toBe(true);
            expect(mockClient.modules.has('general')).toBe(true);
            expect(mockClient.modules.has('economy')).toBe(true);
            expect(mockClient.modules.has('moderation')).toBe(true);
            expect(mockClient.modules.has('xp')).toBe(true);
            expect(mockClient.modules.has('gamerole')).toBe(true);
            expect(mockClient.modules.has('voice')).toBe(true);

            expect(mockClient.commands.has('ping')).toBe(true);
            expect(mockClient.commands.has('balance')).toBe(true);
            expect(mockClient.commands.has('coinflip')).toBe(true);
            expect(mockClient.commands.has('leaderboard')).toBe(true);
            expect(mockClient.commands.has('gamerole')).toBe(true);
            expect(mockClient.commands.has('voice')).toBe(true);
            expect(mockClient.commands.has('testlog')).toBe(true);
            expect(mockClient.commands.has('setlog')).toBe(true);
            expect(mockClient.commands.has('setreward')).toBe(true);
            expect(mockClient.commands.has('kick')).toBe(true);
        });
    });
});
