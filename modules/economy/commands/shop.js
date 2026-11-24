import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import db from '../../../lib/database.js';
import { Member } from '../../../lib/classes/Member.js';
import { SettingsManager } from '../../../lib/settings.js';
import { loggingService } from '../../../lib/bot/loggingService.js';

function resolveEmbedColor(guildId, fallbackColor = 0xF1C40F) {
    try {
        if (typeof SettingsManager.getEmbedColor === 'function') {
            return SettingsManager.getEmbedColor(guildId, 'economy', fallbackColor);
        }
    } catch {}
    return fallbackColor;
}

function createMemberInstance(interaction) {
    const memberTarget = interaction.member?.guild
        ? interaction.member
        : { id: interaction.member?.id || interaction.user.id, guild: interaction.guild };
    return new Member(memberTarget);
}

export default {
    data: new SlashCommandBuilder()
        .setName('shop')
        .setDescription('Browse and purchase items or roles from the server shop.')
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Browse items and roles available in the server shop'))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Purchase an item or role from the server shop')
                .addStringOption(opt =>
                    opt.setName('item')
                        .setDescription('Item ID or name to purchase')
                        .setRequired(true))),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({
                content: 'This command can only be used inside a server.',
                ephemeral: true
            });
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;
        const member = createMemberInstance(interaction);
        const embedColor = resolveEmbedColor(guildId, 0xF1C40F);

        if (subcommand === 'list') {
            const items = db.prepare('SELECT * FROM shop_items WHERE guildId = ? ORDER BY price ASC, id ASC').all(guildId) || [];
            const balance = member.getBalance();

            const embed = new EmbedBuilder()
                .setTitle(`🛒 ${interaction.guild.name || 'Server'} Shop`)
                .setColor(embedColor)
                .setFooter({ text: `Your Balance: ${balance} coins • Use /shop buy to purchase` })
                .setTimestamp();

            if (items.length === 0) {
                embed.setDescription('No items are currently available in this server\'s shop. Check back later!');
            } else {
                const lines = items.map(item => {
                    const stockVal = item.stock === undefined || item.stock === null ? -1 : Number(item.stock);
                    const stockLabel = stockVal < 0
                        ? 'Unlimited'
                        : stockVal === 0
                            ? 'Out of Stock'
                            : `${stockVal} in stock`;

                    const cleanRoleId = String(item.roleId || '').replace(/^["']|["']$/g, '').trim();
                    const details = [];
                    if (cleanRoleId) {
                        details.push(`Role: <@&${cleanRoleId}>`);
                    }
                    details.push(`Stock: **${stockLabel}**`);

                    const entry = [`#${item.id} — **${item.name}** • \`${item.price} coins\``];
                    if (item.description) {
                        entry.push(item.description);
                    }
                    entry.push(details.join(' • '));
                    return entry.join('\n');
                });

                embed.setDescription(lines.join('\n\n').slice(0, 4096));
            }

            return interaction.reply({ embeds: [embed] });
        }

        if (subcommand === 'buy') {
            const rawItemOption = (interaction.options.getString('item') || '').trim();
            if (!rawItemOption) {
                return interaction.reply({
                    content: "Item not found in this server's shop.",
                    ephemeral: true
                });
            }

            let item = null;
            if (/^#?\d+$/.test(rawItemOption)) {
                const numericId = parseInt(rawItemOption.replace(/^#/, ''), 10);
                item = db.prepare('SELECT * FROM shop_items WHERE guildId = ? AND id = ?').get(guildId, numericId);
            }
            if (!item) {
                item = db.prepare('SELECT * FROM shop_items WHERE guildId = ? AND LOWER(name) = LOWER(?)').get(guildId, rawItemOption);
            }

            if (!item) {
                return interaction.reply({
                    content: "Item not found in this server's shop.",
                    ephemeral: true
                });
            }

            const initialStock = item.stock === undefined || item.stock === null ? -1 : Number(item.stock);
            if (initialStock === 0) {
                return interaction.reply({
                    content: 'This item is currently out of stock.',
                    ephemeral: true
                });
            }

            const currentBalance = member.getBalance();
            const price = Number(item.price) || 0;
            if (currentBalance < price) {
                return interaction.reply({
                    content: `Insufficient balance! You need **${price}** coins, but you only have **${currentBalance}** coins.`,
                    ephemeral: true
                });
            }

            const roleId = String(item.roleId || '').replace(/^["']|["']$/g, '').trim();
            if (roleId) {
                if (interaction.member?.roles?.cache?.has?.(roleId)) {
                    return interaction.reply({
                        content: `You already own the <@&${roleId}> role!`,
                        ephemeral: true
                    });
                }

                if (interaction.guild?.roles) {
                    const targetRole = interaction.guild.roles.cache?.get?.(roleId)
                        || (typeof interaction.guild.roles.fetch === 'function'
                            ? await interaction.guild.roles.fetch(roleId).catch(() => null)
                            : null);
                    if (!targetRole) {
                        return interaction.reply({
                            content: `The configured role (<@&${roleId}>) could not be found in this server. You were not charged.`,
                            ephemeral: true
                        });
                    }
                }

                try {
                    if (typeof interaction.member?.roles?.add !== 'function') {
                        throw new Error('Member roles manager unavailable');
                    }
                    await interaction.member.roles.add(roleId);
                } catch {
                    return interaction.reply({
                        content: `Failed to assign the <@&${roleId}> role due to missing permissions or role hierarchy. You were not charged.`,
                        ephemeral: true
                    });
                }
            }

            const now = Date.now();
            const performPurchase = () => {
                const fetchedItem = db.prepare('SELECT * FROM shop_items WHERE guildId = ? AND id = ?').get(guildId, item.id);
                const latestItem = fetchedItem || (db.open ? null : item);
                if (!latestItem) {
                    throw new Error('ITEM_NOT_FOUND');
                }

                const latestStock = latestItem.stock === undefined || latestItem.stock === null ? -1 : Number(latestItem.stock);
                if (latestStock === 0) {
                    throw new Error('OUT_OF_STOCK');
                }

                const latestBalance = member.getBalance();
                if (latestBalance < price) {
                    throw new Error('INSUFFICIENT_FUNDS');
                }

                const updatedBalance = member.addBalance(-(price || 0));

                if (latestStock > 0) {
                    db.prepare('UPDATE shop_items SET stock = stock - 1 WHERE guildId = ? AND id = ? AND stock > 0').run(guildId, item.id);
                }

                db.prepare(`
                    INSERT INTO user_inventory (guildId, userId, itemId, itemName, roleId, quantity, purchasedAt)
                    VALUES (?, ?, ?, ?, ?, 1, ?)
                    ON CONFLICT(guildId, userId, itemId) DO UPDATE SET
                        quantity = quantity + 1,
                        itemName = excluded.itemName,
                        roleId = excluded.roleId,
                        purchasedAt = excluded.purchasedAt
                `).run(guildId, userId, item.id, item.name, roleId, now);

                return updatedBalance;
            };

            let newBalance;
            try {
                const runPurchase = typeof db.transaction === 'function'
                    ? db.transaction(performPurchase)
                    : performPurchase;
                newBalance = runPurchase();
            } catch (err) {
                if (roleId && typeof interaction.member?.roles?.remove === 'function') {
                    await interaction.member.roles.remove(roleId).catch(() => {});
                }
                if (err?.message === 'OUT_OF_STOCK') {
                    return interaction.reply({ content: 'This item is currently out of stock.', ephemeral: true });
                }
                if (err?.message === 'INSUFFICIENT_FUNDS') {
                    const bal = member.getBalance();
                    return interaction.reply({
                        content: `Insufficient balance! You need **${price}** coins, but you only have **${bal}** coins.`,
                        ephemeral: true
                    });
                }
                if (err?.message === 'ITEM_NOT_FOUND') {
                    return interaction.reply({ content: "Item not found in this server's shop.", ephemeral: true });
                }
                throw err;
            }

            const confirmLines = [
                `You purchased **${item.name}** for **${price}** coins!`
            ];
            if (roleId) {
                confirmLines.push(`Assigned Role: <@&${roleId}>`);
            }
            confirmLines.push(`Remaining Balance: **${newBalance}** coins`);

            const embed = new EmbedBuilder()
                .setTitle('🛍️ Purchase Successful')
                .setDescription(confirmLines.join('\n'))
                .setColor(embedColor)
                .setFooter({ text: `Shop Item #${item.id}` })
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

            await loggingService.log(interaction.guild, {
                title: 'Shop Purchase',
                description: `<@${userId}> purchased **${item.name}** for \`${price} coins\`.`,
                color: embedColor,
                eventType: 'log_events_commands',
                user: interaction.user,
                fields: [
                    { name: 'Item', value: `#${item.id} — ${item.name}`, inline: true },
                    { name: 'Price', value: `${price} coins`, inline: true },
                    ...(roleId ? [{ name: 'Role Granted', value: `<@&${roleId}>`, inline: true }] : [])
                ]
            });
        }
    },
};
