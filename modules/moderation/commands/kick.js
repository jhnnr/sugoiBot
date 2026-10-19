import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { loggingService } from '../../../lib/bot/loggingService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kicks a member from the server.')
        .addUserOption(option => 
            option.setName('target')
                .setDescription('The member to kick')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('The reason for kicking'))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
    async execute(interaction) {
        const target = interaction.options.getMember('target');
        const reason = interaction.options.getString('reason') ?? 'No reason provided';

        if (!target) {
            return interaction.reply({ content: 'That user is not in this server.', ephemeral: true });
        }

        if (!target.kickable) {
            return interaction.reply({ content: 'I cannot kick this user. They might have a higher role than me.', ephemeral: true });
        }

        await target.kick(reason);
        await interaction.reply({ content: `Successfully kicked ${target.user.tag} for: ${reason}` });

        await loggingService.log(interaction.guild, {
            title: 'Member Kicked',
            description: `${target.user.tag} was kicked by ${interaction.user.tag}.`,
            color: 0xFFA500,
            eventType: 'log_events_moderation',
            user: target.user,
            fields: [
                { name: 'Reason', value: reason },
                { name: 'Kicked By', value: `${interaction.user.tag} (\`${interaction.user.id}\`)` }
            ]
        });
    },
};
