import { SlashCommandBuilder, AttachmentBuilder } from 'discord.js';
import db from '../../../lib/database.js';
import { generateLeaderboardCard } from '../../../lib/utils/leaderboardCard.js';

export default {
    data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Shows the top ranked members by level and XP.')
        .addIntegerOption(opt => 
            opt.setName('limit')
                .setDescription('Number of top members to display (1-10)')
                .setMinValue(1)
                .setMaxValue(10)),
    async execute(interaction) {
        const limit = interaction.options.getInteger('limit') ?? 10;
        const rows = db.prepare('SELECT userId, xp, level FROM xp ORDER BY level DESC, xp DESC LIMIT ?').all(limit);

        if (!rows || rows.length === 0) {
            return interaction.reply({ content: 'No users have earned XP yet!', ephemeral: true });
        }

        const players = await Promise.all(rows.map(async (row, index) => {
            let user = null;
            if (interaction.guild?.members) {
                const member = await interaction.guild.members.fetch(row.userId).catch(() => null);
                user = member?.user;
            }
            if (!user && interaction.client?.users) {
                user = await interaction.client.users.fetch(row.userId).catch(() => null);
            }
            return {
                rank: index + 1,
                userId: row.userId,
                user: user || { username: `User ${row.userId.slice(-4)}` },
                xp: row.xp,
                level: row.level
            };
        }));

        const buffer = await generateLeaderboardCard(interaction.guild, players);
        const attachment = new AttachmentBuilder(buffer, { name: 'leaderboard.png' });

        await interaction.reply({ files: [attachment] });
    },
};
