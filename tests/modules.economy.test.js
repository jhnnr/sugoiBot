import { describe, it, expect, vi, beforeEach } from 'vitest';
import balanceCommand from '../modules/economy/commands/balance.js';
import dailyCommand from '../modules/economy/commands/daily.js';
import workCommand from '../modules/economy/commands/work.js';
import coinflipCommand from '../modules/economy/commands/coinflip.js';
import shopCommand from '../modules/economy/commands/shop.js';
import inventoryCommand from '../modules/economy/commands/inventory.js';
import { loggingService } from '../lib/bot/loggingService.js';
import db from '../lib/database.js';

vi.mock('../lib/bot/loggingService.js', () => ({
    loggingService: {
        log: vi.fn().mockResolvedValue(true),
    },
}));

vi.mock('../lib/database.js', () => ({
    default: {
        prepare: vi.fn(),
        transaction: vi.fn((fn) => (...args) => fn(...args)),
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

    describe('/shop & /inventory', () => {
        function setupShopSqliteState({
            balance = 500,
            embedColors = null,
            shopItems = [],
            inventory = []
        } = {}) {
            const state = {
                balance,
                shopItems: shopItems.map(item => ({ ...item })),
                inventory: inventory.map(row => ({ ...row }))
            };

            db.prepare.mockImplementation((sql) => {
                const normSql = sql.replace(/\s+/g, ' ').trim();

                if (normSql.includes('FROM guild_settings WHERE guildId = ? AND key = ?')) {
                    return {
                        get: vi.fn((_guildId, key) => {
                            if (key === 'module_embed_colors' && embedColors) {
                                return { value: JSON.stringify(embedColors) };
                            }
                            return undefined;
                        })
                    };
                }

                if (normSql.includes('FROM settings WHERE key = ?')) {
                    return { get: vi.fn().mockReturnValue(undefined) };
                }

                if (normSql.includes('SELECT balance, lastDaily, lastWork FROM currency WHERE userId = ?')) {
                    return {
                        get: vi.fn(() => ({ balance: state.balance, lastDaily: 0, lastWork: 0 }))
                    };
                }

                if (normSql.includes('INSERT INTO currency')) {
                    return {
                        run: vi.fn((_userId, newBalance) => {
                            state.balance = newBalance;
                        })
                    };
                }

                if (normSql.includes('SELECT * FROM shop_items WHERE guildId = ? ORDER BY')) {
                    return {
                        all: vi.fn((guildId) => state.shopItems.filter(i => i.guildId === guildId))
                    };
                }

                if (normSql.includes('SELECT * FROM shop_items WHERE guildId = ? AND id = ?')) {
                    return {
                        get: vi.fn((guildId, id) => state.shopItems.find(i => i.guildId === guildId && i.id === id))
                    };
                }

                if (normSql.includes('SELECT * FROM shop_items WHERE guildId = ? AND LOWER(name) = LOWER(?)')) {
                    return {
                        get: vi.fn((guildId, name) => state.shopItems.find(
                            i => i.guildId === guildId && i.name.toLowerCase() === String(name).toLowerCase()
                        ))
                    };
                }

                if (normSql.includes('UPDATE shop_items SET stock = stock - 1')) {
                    return {
                        run: vi.fn((guildId, id) => {
                            const found = state.shopItems.find(i => i.guildId === guildId && i.id === id && i.stock > 0);
                            if (found) found.stock -= 1;
                        })
                    };
                }

                if (normSql.includes('INSERT INTO user_inventory')) {
                    return {
                        run: vi.fn((guildId, userId, itemId, itemName, roleId, purchasedAt) => {
                            const existing = state.inventory.find(
                                r => r.guildId === guildId && r.userId === userId && r.itemId === itemId
                            );
                            if (existing) {
                                existing.quantity += 1;
                                existing.itemName = itemName;
                                existing.roleId = roleId;
                                existing.purchasedAt = purchasedAt;
                            } else {
                                state.inventory.push({
                                    guildId,
                                    userId,
                                    itemId,
                                    itemName,
                                    roleId,
                                    quantity: 1,
                                    purchasedAt
                                });
                            }
                        })
                    };
                }

                if (normSql.includes('SELECT * FROM user_inventory WHERE guildId = ? AND userId = ?')) {
                    return {
                        all: vi.fn((guildId, userId) => state.inventory.filter(
                            r => r.guildId === guildId && r.userId === userId
                        ))
                    };
                }

                return { get: vi.fn(), all: vi.fn(() => []), run: vi.fn() };
            });

            return state;
        }

        it('/shop list should display empty state when no items exist and formatted catalog with custom embed color when populated', async () => {
            // 1. Empty shop
            setupShopSqliteState({ balance: 320, shopItems: [] });
            const emptyReply = vi.fn();
            await shopCommand.execute({
                guild: { id: 'g100', name: 'Sugoi Guild' },
                user: mockUser,
                member: mockMember,
                options: { getSubcommand: () => 'list' },
                reply: emptyReply
            });

            const emptyEmbed = emptyReply.mock.calls[0][0].embeds[0].toJSON();
            expect(emptyEmbed.color).toBe(0xF1C40F);
            expect(emptyEmbed.description).toContain("No items are currently available in this server's shop");
            expect(emptyEmbed.footer.text).toContain('Your Balance: 320 coins');

            // 2. Populated shop with custom economy embed color, role tags, and stock states
            setupShopSqliteState({
                balance: 850,
                embedColors: { economy: '#12AB34' },
                shopItems: [
                    { id: 1, guildId: 'g100', name: 'VIP Pass', description: 'Access VIP lounge', price: 400, roleId: 'role_vip', stock: 3 },
                    { id: 2, guildId: 'g100', name: 'Mystery Crate', description: '', price: 150, roleId: '', stock: -1 },
                    { id: 3, guildId: 'g100', name: 'Limited Crown', description: 'Rare cosmetic', price: 999, roleId: '', stock: 0 }
                ]
            });

            const listReply = vi.fn();
            await shopCommand.execute({
                guild: { id: 'g100', name: 'Sugoi Guild' },
                user: mockUser,
                member: mockMember,
                options: { getSubcommand: () => 'list' },
                reply: listReply
            });

            const listEmbed = listReply.mock.calls[0][0].embeds[0].toJSON();
            expect(listEmbed.color).toBe(0x12AB34);
            expect(listEmbed.description).toContain('#1 — **VIP Pass** • `400 coins`');
            expect(listEmbed.description).toContain('Role: <@&role_vip> • Stock: **3 in stock**');
            expect(listEmbed.description).toContain('#2 — **Mystery Crate** • `150 coins`');
            expect(listEmbed.description).toContain('Stock: **Unlimited**');
            expect(listEmbed.description).toContain('Stock: **Out of Stock**');
        });

        it('/shop buy should deduct coins, decrement finite stock, increment user_inventory, and assign Discord role', async () => {
            const state = setupShopSqliteState({
                balance: 1000,
                embedColors: { economy: '#00CC88' },
                shopItems: [
                    { id: 1, guildId: 'g100', name: 'VIP Pass', description: 'VIP role', price: 400, roleId: 'role_vip', stock: 2 },
                    { id: 2, guildId: 'g100', name: 'Health Potion', description: 'Consumable', price: 100, roleId: '', stock: 5 }
                ]
            });

            const memberRolesCache = new Map();
            const addRoleMock = vi.fn().mockImplementation(async (rId) => {
                memberRolesCache.set(rId, { id: rId });
            });
            const guildObj = {
                id: 'g100',
                name: 'Sugoi Guild',
                roles: {
                    cache: new Map([['role_vip', { id: 'role_vip', name: 'VIP' }]]),
                    fetch: vi.fn()
                }
            };
            const buyerMember = {
                id: 'u100',
                guild: guildObj,
                user: mockUser,
                roles: {
                    cache: memberRolesCache,
                    add: addRoleMock
                }
            };

            // Buy role item (#1)
            const buyRoleReply = vi.fn();
            await shopCommand.execute({
                guild: guildObj,
                user: mockUser,
                member: buyerMember,
                options: {
                    getSubcommand: () => 'buy',
                    getString: () => '#1'
                },
                reply: buyRoleReply
            });

            expect(addRoleMock).toHaveBeenCalledWith('role_vip');
            expect(state.balance).toBe(600);
            expect(state.shopItems[0].stock).toBe(1);
            expect(state.inventory).toEqual([
                expect.objectContaining({ guildId: 'g100', userId: 'u100', itemId: 1, itemName: 'VIP Pass', roleId: 'role_vip', quantity: 1 })
            ]);
            const confirmEmbed = buyRoleReply.mock.calls[0][0].embeds[0].toJSON();
            expect(confirmEmbed.color).toBe(0x00CC88);
            expect(confirmEmbed.description).toContain('Assigned Role: <@&role_vip>');
            expect(confirmEmbed.description).toContain('Remaining Balance: **600** coins');
            expect(loggingService.log).toHaveBeenCalledWith(
                guildObj,
                expect.objectContaining({ title: 'Shop Purchase', eventType: 'log_events_commands' })
            );

            // Buy stackable item twice by name -> increments quantity to 2 and decrements stock by 2
            await shopCommand.execute({
                guild: guildObj,
                user: mockUser,
                member: buyerMember,
                options: { getSubcommand: () => 'buy', getString: () => 'health potion' },
                reply: vi.fn()
            });
            await shopCommand.execute({
                guild: guildObj,
                user: mockUser,
                member: buyerMember,
                options: { getSubcommand: () => 'buy', getString: () => 'Health Potion' },
                reply: vi.fn()
            });

            expect(state.balance).toBe(400);
            expect(state.shopItems[1].stock).toBe(3);
            expect(state.inventory.find(i => i.itemId === 2).quantity).toBe(2);
        });

        it('/shop buy should reject out-of-stock, insufficient funds, and already-owned roles without deducting coins', async () => {
            const state = setupShopSqliteState({
                balance: 300,
                shopItems: [
                    { id: 1, guildId: 'g100', name: 'Sold Out Hat', price: 100, roleId: '', stock: 0 },
                    { id: 2, guildId: 'g100', name: 'Dragon Armor', price: 900, roleId: '', stock: 5 },
                    { id: 3, guildId: 'g100', name: 'VIP Role', price: 200, roleId: 'role_owned', stock: 4 }
                ]
            });

            const addRoleMock = vi.fn();
            const guildObj = {
                id: 'g100',
                roles: { cache: new Map([['role_owned', { id: 'role_owned' }]]) }
            };
            const buyerMember = {
                id: 'u100',
                guild: guildObj,
                user: mockUser,
                roles: {
                    cache: new Map([['role_owned', { id: 'role_owned' }]]),
                    add: addRoleMock
                }
            };

            // 1. Out of stock
            const oosReply = vi.fn();
            await shopCommand.execute({
                guild: guildObj,
                user: mockUser,
                member: buyerMember,
                options: { getSubcommand: () => 'buy', getString: () => '1' },
                reply: oosReply
            });
            expect(oosReply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('out of stock'),
                ephemeral: true
            }));
            expect(state.balance).toBe(300);

            // 2. Insufficient funds
            const poorReply = vi.fn();
            await shopCommand.execute({
                guild: guildObj,
                user: mockUser,
                member: buyerMember,
                options: { getSubcommand: () => 'buy', getString: () => 'Dragon Armor' },
                reply: poorReply
            });
            expect(poorReply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Insufficient balance! You need **900** coins, but you only have **300** coins.'),
                ephemeral: true
            }));
            expect(state.balance).toBe(300);
            expect(state.shopItems[1].stock).toBe(5);

            // 3. Already-owned role -> rejected before deducting coins or decrementing stock
            const ownedReply = vi.fn();
            await shopCommand.execute({
                guild: guildObj,
                user: mockUser,
                member: buyerMember,
                options: { getSubcommand: () => 'buy', getString: () => 'VIP Role' },
                reply: ownedReply
            });
            expect(ownedReply).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('already own the <@&role_owned> role'),
                ephemeral: true
            }));
            expect(addRoleMock).not.toHaveBeenCalled();
            expect(state.balance).toBe(300);
            expect(state.shopItems[2].stock).toBe(4);
            expect(state.inventory).toHaveLength(0);
        });

        it('/inventory should display empty state or owned items with quantities and custom embed color', async () => {
            // 1. Empty inventory
            setupShopSqliteState({ inventory: [] });
            const emptyReply = vi.fn();
            await inventoryCommand.execute({
                guild: { id: 'g100' },
                user: { id: 'u100', username: 'PlayerOne', displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/p1.png' },
                options: { getUser: () => null },
                reply: emptyReply
            });
            const emptyEmbed = emptyReply.mock.calls[0][0].embeds[0].toJSON();
            expect(emptyEmbed.description).toContain('Your inventory is empty!');

            // 2. Populated inventory with custom embed color
            setupShopSqliteState({
                embedColors: { economy: '#FF8800' },
                inventory: [
                    { guildId: 'g100', userId: 'u100', itemId: 1, itemName: 'VIP Pass', roleId: 'role_vip', quantity: 1, purchasedAt: 2000 },
                    { guildId: 'g100', userId: 'u100', itemId: 2, itemName: 'Health Potion', roleId: '', quantity: 3, purchasedAt: 1000 }
                ]
            });
            const invReply = vi.fn();
            await inventoryCommand.execute({
                guild: { id: 'g100' },
                user: { id: 'u100', username: 'PlayerOne', displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/p1.png' },
                options: { getUser: () => null },
                reply: invReply
            });

            const invEmbed = invReply.mock.calls[0][0].embeds[0].toJSON();
            expect(invEmbed.color).toBe(0xFF8800);
            expect(invEmbed.title).toContain("PlayerOne's Inventory");
            expect(invEmbed.description).toContain('• **VIP Pass** `x1` • <@&role_vip>');
            expect(invEmbed.description).toContain('• **Health Potion** `x3`');
            expect(invEmbed.footer.text).toBe('2 unique item(s) • 4 total');
        });
    });
});
