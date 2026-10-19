import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { SettingsManager } from '../../../lib/settings.js';

export default {
    data: new SlashCommandBuilder()
        .setName('testlog')
        .setDescription('Sends a test audit log message to verify your logging configuration.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        }

        const rawChannelId = SettingsManager.getGuild(interaction.guild.id, 'log_channel_id') || SettingsManager.get('log_channel_id');
        if (!rawChannelId) {
            return interaction.reply({
                content: '⚠️ No log channel configured for this server. Please set a **Log Channel ID** in the dashboard first.',
                ephemeral: true
            });
        }

        const logChannelId = String(rawChannelId).replace(/^["']|["']$/g, '').trim();

        const channel = interaction.guild.channels.cache.get(logChannelId)
            || await interaction.guild.channels.fetch(logChannelId).catch(() => null)
            || await interaction.client.channels.fetch(logChannelId).catch(() => null);

        if (!channel) {
            return interaction.reply({
                content: `❌ Could not find channel with ID \`${logChannelId}\`. Please check that the channel ID is correct and that the bot is in the server.`,
                ephemeral: true
            });
        }

        // Check bot permissions in target channel
        const botMember = interaction.guild.members.me;
        const permissions = channel.permissionsFor(botMember);

        if (permissions && (!permissions.has('ViewChannel') || !permissions.has('SendMessages') || !permissions.has('EmbedLinks'))) {
            const missing = [];
            if (!permissions.has('ViewChannel')) missing.push('View Channel');
            if (!permissions.has('SendMessages')) missing.push('Send Messages');
            if (!permissions.has('EmbedLinks')) missing.push('Embed Links');

            return interaction.reply({
                content: `❌ The bot lacks required permissions in <#${logChannelId}>: **${missing.join(', ')}**. Please update the channel permissions for the bot role.`,
                ephemeral: true
            });
        }

        const now = Math.floor(Date.now() / 1000);
        const avatarUrl = typeof interaction.user?.displayAvatarURL === 'function'
            ? interaction.user.displayAvatarURL({ size: 128 })
            : undefined;

        const testEmbed = new EmbedBuilder()
            .setAuthor({
                name: interaction.user.tag,
                iconURL: avatarUrl
            })
            .setTitle('✅ Logging System Verification')
            .setDescription(`This is a test audit log dispatched by **${interaction.user.tag}** using \`/testlog\`.\n\nYour logging configuration is working properly!`)
            .setColor(0x57F287)
            .addFields(
                { name: 'Target Channel', value: `<#${channel.id}> (\`${channel.id}\`)`, inline: true },
                { name: 'Server', value: `${interaction.guild.name} (\`${interaction.guild.id}\`)`, inline: true },
                { name: 'Dispatched By', value: `${interaction.user.tag}`, inline: true },
                { name: '🕒 Timestamp', value: `<t:${now}:F> (<t:${now}:R>)`, inline: false }
            )
            .setFooter({ text: `Audit Log • ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}` })
            .setTimestamp();

        try {
            await channel.send({ embeds: [testEmbed] });
            return interaction.reply({
                content: `✅ Successfully dispatched a test audit log to <#${channel.id}>! Check the channel.`,
                ephemeral: true
            });
        } catch (error) {
            return interaction.reply({
                content: `❌ Failed to send message to <#${channel.id}>: \`${error.message}\`. Please check channel permissions.`,
                ephemeral: true
            });
        }
    },
};
