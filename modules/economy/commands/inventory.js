import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import db from '../../../lib/database.js';
import { SettingsManager } from '../../../lib/settings.js';

function resolveEmbedColor(guildId, fallbackColor = 0xF1C40F) {
    try {
        if (typeof SettingsManager.getEmbedColor === 'function') {
            return SettingsManager.getEmbedColor(guildId, 'economy', fallbackColor);
        }
    } catch {}
    return fallbackColor;
}

export default {
    data: new SlashCommandBuilder()
        .setName('inventory')
        .setDescription('View your purchased server shop items')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Member to view inventory for')
                .setRequired(false)),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({
                content: 'This command can only be used inside a server.',
                ephemeral: true
            });
        }

        const targetUser = interaction.options?.getUser?.('user') || interaction.user;
        const guildId = interaction.guild.id;
        const rows = db.prepare(
            'SELECT * FROM user_inventory WHERE guildId = ? AND userId = ? ORDER BY purchasedAt DESC'
        ).all(guildId, targetUser.id) || [];

        const embedColor = resolveEmbedColor(guildId, 0xF1C40F);
        const displayName = targetUser.username || targetUser.tag || 'Member';

        const embed = new EmbedBuilder()
            .setTitle(`🎒 ${displayName}'s Inventory`)
            .setColor(embedColor)
            .setTimestamp();

        if (typeof targetUser.displayAvatarURL === 'function') {
            const avatarUrl = targetUser.displayAvatarURL({ size: 128 });
            if (avatarUrl) embed.setThumbnail(avatarUrl);
        }

        if (rows.length === 0) {
            embed.setDescription(
                targetUser.id === interaction.user.id
                    ? 'Your inventory is empty! Use `/shop list` to browse available items.'
                    : `${displayName} does not own any shop items in this server yet.`
            );
        } else {
            const totalQuantity = rows.reduce((sum, r) => sum + (Number(r.quantity) || 1), 0);
            const lines = rows.map(row => {
                const qty = Number(row.quantity) || 1;
                const cleanRoleId = String(row.roleId || '').replace(/^["']|["']$/g, '').trim();
                const roleSuffix = cleanRoleId ? ` • <@&${cleanRoleId}>` : '';
                return `• **${row.itemName}** \`x${qty}\`${roleSuffix}`;
            });
            embed.setDescription(lines.join('\n').slice(0, 4096));
            embed.setFooter({ text: `${rows.length} unique item(s) • ${totalQuantity} total` });
        }

        return interaction.reply({ embeds: [embed] });
    },
};
