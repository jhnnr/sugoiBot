import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { loggingService } from '../../../lib/bot/loggingService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Bans a member from the server.')
        .addUserOption(option => 
            option.setName('target')
                .setDescription('The member to ban')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('The reason for banning'))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    async execute(interaction) {
        const target = interaction.options.getMember('target');
        const reason = interaction.options.getString('reason') ?? 'No reason provided';

        if (!target) {
            return interaction.reply({ content: 'That user is not in this server.', ephemeral: true });
        }

        if (!target.bannable) {
            return interaction.reply({ content: 'I cannot ban this user. They might have a higher role than me.', ephemeral: true });
        }

        await target.ban({ reason });
        await interaction.reply({ content: `Successfully banned ${target.user.tag} for: ${reason}` });

        await loggingService.log(interaction.guild, {
            title: 'Member Banned',
            description: `${target.user.tag} was banned by ${interaction.user.tag}.`,
            color: 0xFF0000,
            eventType: 'log_events_moderation',
            user: target.user,
            fields: [
                { name: 'Reason', value: reason },
                { name: 'Banned By', value: `${interaction.user.tag} (\`${interaction.user.id}\`)` }
            ]
        });
    },
};
