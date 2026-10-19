import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import db from '../../../lib/database.js';

/**
 * Creates the interactive voice interface embed sent inside the voice channel's chat
 */
export function createVoiceInterfaceEmbed() {
    return new EmbedBuilder()
        .setTitle('🔊 Voice Room Controls')
        .setDescription(
            'Use the buttons below to manage your temporary voice channel directly from this chat!\n\n' +
            '🔒 **Lock** • Restricts join access to everyone\n' +
            '🔓 **Unlock** • Re-opens room access to the public\n' +
            '👻 **Ghost** • Hides channel visibility\n' +
            '👀 **Unhide** • Restores channel visibility\n' +
            '✏️ **Rename** • Customizes the voice channel title\n' +
            '👥 **Limit** • Sets the maximum participant cap\n' +
            '👑 **Claim** • Takes ownership if the original host leaves\n' +
            'ℹ️ **Info** • Shows room statistics and ownership'
        )
        .setColor(0x5865F2)
        .setFooter({ text: 'Temporary Voice Rooms' });
}

/**
 * Creates interactive button rows for the voice interface
 */
export function createVoiceInterfaceComponents() {
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vm_lock').setLabel('Lock').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vm_unlock').setLabel('Unlock').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vm_ghost').setLabel('Ghost').setEmoji('👻').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vm_unhide').setLabel('Unhide').setEmoji('👀').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vm_claim').setLabel('Claim').setEmoji('👑').setStyle(ButtonStyle.Primary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vm_rename').setLabel('Rename').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vm_limit').setLabel('Limit').setEmoji('👥').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vm_info').setLabel('Info').setEmoji('ℹ️').setStyle(ButtonStyle.Secondary)
    );

    return [row1, row2];
}

/**
 * Get channel record from voice_channels table
 */
export function getVoiceRecord(channelId) {
    let row = db.prepare('SELECT * FROM voice_channels WHERE channelId = ?').get(channelId);
    if (!row) {
        row = db.prepare('SELECT * FROM voicemaster_channels WHERE channelId = ?').get(channelId);
    }
    return row;
}

/**
 * Get the user's currently owned temporary channel in a guild
 */
export function getOwnedChannelInGuild(guildId, ownerId) {
    let row = db.prepare('SELECT * FROM voice_channels WHERE guildId = ? AND ownerId = ?').get(guildId, ownerId);
    if (!row) {
        row = db.prepare('SELECT * FROM voicemaster_channels WHERE guildId = ? AND ownerId = ?').get(guildId, ownerId);
    }
    return row;
}

/**
 * Get the setup hub configuration for a guild (returns latest created hub)
 */
export function getVoiceHubConfig(guildId) {
    let row = db.prepare('SELECT * FROM voice_hubs WHERE guildId = ? ORDER BY rowid DESC').get(guildId);
    if (!row) {
        row = db.prepare('SELECT * FROM voice_guilds WHERE guildId = ?').get(guildId);
    }
    if (!row) {
        row = db.prepare('SELECT * FROM voicemaster_guilds WHERE guildId = ?').get(guildId);
    }
    return row;
}

/**
 * Check if a channel is any registered hub channel (Join to Create)
 */
export function isHubChannel(channelId) {
    if (!channelId) return false;
    let row = db.prepare('SELECT 1 FROM voice_hubs WHERE hubChannelId = ?').get(channelId);
    if (row) return true;
    row = db.prepare('SELECT 1 FROM voice_guilds WHERE hubChannelId = ?').get(channelId);
    if (row) return true;
    row = db.prepare('SELECT 1 FROM voicemaster_guilds WHERE hubChannelId = ?').get(channelId);
    return Boolean(row);
}

/**
 * Get hub configuration for a specific hubChannelId
 */
export function getHubConfig(channelId) {
    if (!channelId) return null;
    let row = db.prepare('SELECT * FROM voice_hubs WHERE hubChannelId = ?').get(channelId);
    if (!row) {
        row = db.prepare('SELECT * FROM voice_guilds WHERE hubChannelId = ?').get(channelId);
    }
    if (!row) {
        row = db.prepare('SELECT * FROM voicemaster_guilds WHERE hubChannelId = ?').get(channelId);
    }
    return row;
}

/**
 * Get all registered hubs in a guild
 */
export function getAllHubsInGuild(guildId) {
    if (!guildId) return [];
    let rows = db.prepare('SELECT * FROM voice_hubs WHERE guildId = ?').all(guildId);
    if (!rows || rows.length === 0) {
        rows = db.prepare('SELECT * FROM voice_guilds WHERE guildId = ?').all(guildId);
    }
    return rows || [];
}

/**
 * Get user's cross-server persistent voice settings
 */
export function getUserVoiceSettings(userId) {
    if (!userId) return null;
    return db.prepare('SELECT * FROM voice_user_settings WHERE userId = ?').get(userId);
}

/**
 * Save user's cross-server persistent voice settings
 */
export function saveUserVoiceSettings(userId, { customName, customLimit }) {
    if (!userId) return;
    const current = getUserVoiceSettings(userId) || {};
    const nameToSave = customName !== undefined ? customName : current.customName;
    const limitToSave = customLimit !== undefined ? customLimit : current.customLimit;

    db.prepare(`
        INSERT INTO voice_user_settings (userId, customName, customLimit, updatedAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(userId) DO UPDATE SET
            customName = excluded.customName,
            customLimit = excluded.customLimit,
            updatedAt = excluded.updatedAt
    `).run(userId, nameToSave, limitToSave, Date.now());
}

/**
 * Get all channels owned by user in guild
 */
export function getOwnedChannelsInGuild(guildId, ownerId) {
    return db.prepare('SELECT * FROM voice_channels WHERE guildId = ? AND ownerId = ?').all(guildId, ownerId);
}
