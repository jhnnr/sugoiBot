import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Collection } from 'discord.js';
import gameroleCommand from '../modules/gamerole/commands/gamerole.js';
import presenceUpdateEvent from '../modules/gamerole/events/presenceUpdate.js';
import db from '../lib/database.js';
import { SettingsManager } from '../lib/settings.js';

vi.mock('../lib/database.js', () => ({
    default: {
        prepare: vi.fn(),
    },
}));

vi.mock('../lib/settings.js', () => ({
    SettingsManager: {
        getGuildJson: vi.fn().mockReturnValue(true),
        getGuild: vi.fn().mockReturnValue('PLAYING '),
    },
}));

describe('GameRole Module', () => {
    let mockGuild;
    let mockMember;

    beforeEach(() => {
        vi.clearAllMocks();
        mockGuild = {
            id: 'g500',
            name: 'Game Guild',
            roles: {
                cache: new Collection(),
                highest: { rawPosition: 10 },
                create: vi.fn()
            }
        };
        mockMember = {
            id: 'u500',
            roles: {
                cache: new Collection(),
                add: vi.fn().mockResolvedValue(true),
                remove: vi.fn().mockResolvedValue(true)
            },
            user: { bot: false, username: 'Gamer' }
        };
    });

    describe('/gamerole command', () => {
        it('should add a game to the whitelist', async () => {
            const mockRun = vi.fn();
            db.prepare.mockReturnValue({ run: mockRun });

            const reply = vi.fn();
            const interaction = {
                guild: mockGuild,
                options: {
                    getSubcommand: () => 'add',
                    getString: vi.fn().mockImplementation((opt) => opt === 'game' ? 'Valorant' : 'Valorant')
                },
                reply
            };

            await gameroleCommand.execute(interaction);

            expect(mockRun).toHaveBeenCalledWith('g500', 'Valorant', 'Valorant');
            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Added **Valorant** to the GameRole whitelist')
            }));
        });

        it('should list whitelisted games', async () => {
            db.prepare.mockReturnValue({
                all: vi.fn().mockReturnValue([
                    { gameName: 'Minecraft', roleName: 'Minecraft' },
                    { gameName: 'Valorant', roleName: 'Valorant' }
                ])
            });

            const reply = vi.fn();
            const interaction = {
                guild: mockGuild,
                options: {
                    getSubcommand: () => 'list',
                    getInteger: vi.fn().mockReturnValue(1)
                },
                reply
            };

            await gameroleCommand.execute(interaction);

            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                embeds: expect.any(Array)
            }));
        });

        it('should remove a custom game from the whitelist', async () => {
            const mockRun = vi.fn().mockReturnValue({ changes: 1 });
            db.prepare.mockReturnValue({ run: mockRun });

            const reply = vi.fn();
            const interaction = {
                guild: mockGuild,
                options: {
                    getSubcommand: () => 'remove',
                    getString: () => 'MyCustomGame'
                },
                reply
            };

            await gameroleCommand.execute(interaction);

            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Removed **MyCustomGame**')
            }));
        });

        it('should disable a default game for this server', async () => {
            const mockRun = vi.fn().mockReturnValue({ changes: 1 });
            db.prepare.mockReturnValue({ run: mockRun });

            const reply = vi.fn();
            const interaction = {
                guild: mockGuild,
                options: {
                    getSubcommand: () => 'remove',
                    getString: () => 'Valorant'
                },
                reply
            };

            await gameroleCommand.execute(interaction);

            expect(reply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Disabled **Valorant**')
            }));
        });
    });

    describe('presenceUpdate event', () => {
        it('should create and assign role when playing a whitelisted game', async () => {
            const mockCreatedRole = { id: 'role_val', name: 'PLAYING Valorant' };
            mockGuild.roles.create.mockResolvedValue(mockCreatedRole);

            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue({ roleName: 'Valorant' })
            });

            const oldPresence = {
                activities: []
            };

            const newPresence = {
                guild: mockGuild,
                member: mockMember,
                activities: [
                    { type: 0, name: 'Valorant' }
                ]
            };

            await presenceUpdateEvent.execute(oldPresence, newPresence);

            expect(mockGuild.roles.create).toHaveBeenCalledWith(expect.objectContaining({
                name: 'PLAYING Valorant',
                hoist: true
            }));
            expect(mockMember.roles.add).toHaveBeenCalledWith('role_val');
        });

        it('should recognize and assign roles for games in the built-in default whitelist', async () => {
            const mockCreatedRole = { id: 'role_lol', name: 'PLAYING League of Legends' };
            mockGuild.roles.create.mockResolvedValue(mockCreatedRole);

            // Database has no custom entry
            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue(undefined)
            });

            const oldPresence = { activities: [] };
            const newPresence = {
                guild: mockGuild,
                member: mockMember,
                activities: [{ type: 0, name: 'League of Legends' }]
            };

            await presenceUpdateEvent.execute(oldPresence, newPresence);

            expect(mockGuild.roles.create).toHaveBeenCalledWith(expect.objectContaining({
                name: 'PLAYING League of Legends'
            }));
            expect(mockMember.roles.add).toHaveBeenCalledWith('role_lol');
        });

        it('should place new PLAYING role at bottom of existing PLAYING roles', async () => {
            const setPositionMock = vi.fn().mockResolvedValue();
            const mockCreatedRole = { id: 'role_new', name: 'PLAYING Dota 2', position: 50, setPosition: setPositionMock };
            mockGuild.roles.create.mockResolvedValue(mockCreatedRole);

            // Existing playing roles at positions 20 and 15
            mockGuild.roles.cache.set('existing1', { id: 'existing1', name: 'PLAYING Valorant', position: 20 });
            mockGuild.roles.cache.set('existing2', { id: 'existing2', name: 'PLAYING Apex', position: 15 });
            mockGuild.members = { me: { roles: { highest: { position: 30 } } } };

            db.prepare.mockReturnValue({
                get: vi.fn().mockReturnValue(undefined)
            });

            const oldPresence = { activities: [] };
            const newPresence = {
                guild: mockGuild,
                member: mockMember,
                activities: [{ type: 0, name: 'Dota 2' }]
            };

            await presenceUpdateEvent.execute(oldPresence, newPresence);

            expect(mockGuild.roles.create).toHaveBeenCalledWith(expect.objectContaining({
                name: 'PLAYING Dota 2'
            }));
            expect(setPositionMock).toHaveBeenCalledWith(15);
        });

        it('should remove role when member stops playing', async () => {
            const existingRole = { id: 'role_val', name: 'PLAYING Valorant' };
            mockGuild.roles.cache.set(existingRole.id, existingRole);
            mockMember.roles.cache.set(existingRole.id, existingRole);

            const oldPresence = {
                activities: [
                    { type: 0, name: 'Valorant' }
                ]
            };

            const newPresence = {
                guild: mockGuild,
                member: mockMember,
                activities: []
            };

            await presenceUpdateEvent.execute(oldPresence, newPresence);

            expect(mockMember.roles.remove).toHaveBeenCalledWith('role_val');
        });
    });
});
