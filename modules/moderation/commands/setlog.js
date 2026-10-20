import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import { SettingsManager } from '../../../lib/settings.js';

export default {
    data: new SlashCommandBuilder()
        .setName('setlog')
        .setDescription('Set the server audit log channel directly in this server.')
        .addChannelOption(opt =>
            opt.setName('channel')
                .setDescription('The text channel to send server audit logs to')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        }

        const channel = interaction.options.getChannel('channel');
        const guild = interaction.guild;

        // Check bot permissions in target channel
        const botMember = guild.members.me;
        const permissions = channel.permissionsFor(botMember);

        if (permissions && (!permissions.has('ViewChannel') || !permissions.has('SendMessages') || !permissions.has('EmbedLinks'))) {
            const missing = [];
            if (!permissions.has('ViewChannel')) missing.push('View Channel');
            if (!permissions.has('SendMessages')) missing.push('Send Messages');
            if (!permissions.has('EmbedLinks')) missing.push('Embed Links');

            return interaction.reply({
                content: `⚠️ Warning: The bot lacks required permissions in <#${channel.id}>: **${missing.join(', ')}**. Please update the channel permissions for the bot role.`,
                ephemeral: true
            });
        }

        // Save channel ID strictly for this guild
        SettingsManager.setGuildJson(guild.id, 'log_channel_id', channel.id);

        const testEmbed = new EmbedBuilder()
            .setAuthor({
                name: interaction.user.tag,
                iconURL: interaction.user.displayAvatarURL?.({ size: 128 })
            })
            .setTitle('✅ Log Channel Configured')
            .setDescription(`This channel has been set as the audit log channel for **${guild.name}** by ${interaction.user}.`)
            .setColor(0x57F287)
            .setTimestamp();

        await channel.send({ embeds: [testEmbed] }).catch(() => {});

        return interaction.reply({
            content: `✅ Successfully configured <#${channel.id}> as the audit log destination for **${guild.name}**!`,
            ephemeral: true
        });
    },
};
