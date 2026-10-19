import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Member } from '../../../lib/classes/Member.js';
import { loggingService } from '../../../lib/bot/loggingService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Warns a member and stores it in the database.')
        .addUserOption(option => 
            option.setName('target')
                .setDescription('The member to warn')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('The reason for warning')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    async execute(interaction) {
        const targetMember = interaction.options.getMember('target');
        const targetUser = interaction.options.getUser('target');
        const reason = interaction.options.getString('reason');
        const moderator = interaction.user;

        if (!targetMember) {
            return interaction.reply({ content: 'That user is not in this server.', ephemeral: true });
        }

        const member = new Member(targetMember);
        member.addWarning(reason, moderator.id);
        const warningCount = member.getWarnings().length;

        await interaction.reply({ content: `Successfully warned ${targetUser.tag} for: ${reason}. They now have ${warningCount} warning(s).` });

        await loggingService.log(interaction.guild, {
            title: 'Member Warned',
            description: `${targetUser.tag} was warned by ${moderator.tag}.`,
            color: 0xFEE75C,
            eventType: 'log_events_moderation',
            user: targetUser,
            fields: [
                { name: 'Reason', value: reason },
                { name: 'Total Warnings', value: String(warningCount) },
                { name: 'Warned By', value: `${moderator.tag} (\`${moderator.id}\`)` }
            ]
        });
    },
};
