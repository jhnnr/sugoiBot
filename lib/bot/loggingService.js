import { EmbedBuilder } from 'discord.js';
import { SettingsManager } from '../settings.js';

export const loggingService = {
    /**
     * Log an event to the configured log channel
     * @param {import('discord.js').Guild} guild 
     * @param {object} options 
     */
    async log(guild, { title, description, color = 0x00AE86, fields = [], eventType = null, thumbnail = null, image = null, user = null, author = null }) {
        if (!guild) return;

        if (eventType) {
            const enabled = SettingsManager.getGuildJson(guild.id, eventType, true);
            if (!enabled) return;
        }

        const rawChannelId = SettingsManager.getGuild(guild.id, 'log_channel_id');
        if (!rawChannelId) return;

        const logChannelId = String(rawChannelId).replace(/^["']|["']$/g, '').trim();
        if (!logChannelId) return;

        const channel = guild.channels?.cache?.get(logChannelId)
            || await guild.channels?.fetch(logChannelId).catch(() => null)
            || await guild.client?.channels?.fetch(logChannelId).catch(() => null);

        if (!channel) {
            console.warn(`[LOGGING] Channel ID "${logChannelId}" could not be resolved for guild "${guild.name}" (${guild.id}). Check bot channel permissions.`);
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTimestamp();

        if (title) {
            embed.setTitle(title);
        }

        // Author header with small profile picture and username
        if (author) {
            embed.setAuthor(author);
        } else if (user) {
            const iconUrl = typeof user.displayAvatarURL === 'function'
                ? user.displayAvatarURL({ size: 128 })
                : null;
            embed.setAuthor({
                name: user.username || user.tag || 'User',
                iconURL: iconUrl || undefined
            });
        }

        embed.setDescription(description || 'No description provided');

        if (fields.length > 0) {
            embed.addFields(fields);
        }

        if (thumbnail) embed.setThumbnail(thumbnail);
        if (image) embed.setImage(image);

        try {
            await channel.send({ embeds: [embed] });
        } catch (error) {
            console.error(`[ERROR] Failed to send log to channel ${logChannelId}:`, error.message);
        }
    }
};
