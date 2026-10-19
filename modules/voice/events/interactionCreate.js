import {
    Events,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    EmbedBuilder
} from 'discord.js';
import db from '../../../lib/database.js';
import { getVoiceRecord, saveUserVoiceSettings } from '../lib/voiceHelper.js';

export default {
    name: Events.InteractionCreate,
    async execute(interaction) {
        if (!interaction.guild) return;

        // --- Handle Modal Submissions ---
        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'vm_modal_rename') {
                const voiceChannel = interaction.channel?.isVoiceBased?.()
                    ? interaction.channel
                    : interaction.member.voice?.channel;
                const record = voiceChannel ? getVoiceRecord(voiceChannel.id) : null;

                if (!voiceChannel || !record || record.ownerId !== interaction.user.id) {
                    return interaction.reply({ content: '⚠️ You must own and be inside your voice room to rename it.', ephemeral: true });
                }

                const newName = interaction.fields.getTextInputValue('vm_input_name').trim();
                await voiceChannel.setName(newName);
                saveUserVoiceSettings(interaction.user.id, { customName: newName });
                return interaction.reply({
                    content: `✏️ Room renamed to **${newName}**! *(Saved as your default room name across servers)*`,
                    ephemeral: true
                });
            }

            if (interaction.customId === 'vm_modal_limit') {
                const voiceChannel = interaction.channel?.isVoiceBased?.()
                    ? interaction.channel
                    : interaction.member.voice?.channel;
                const record = voiceChannel ? getVoiceRecord(voiceChannel.id) : null;

                if (!voiceChannel || !record || record.ownerId !== interaction.user.id) {
                    return interaction.reply({ content: '⚠️ You must own and be inside your voice room to change its user limit.', ephemeral: true });
                }

                const limitStr = interaction.fields.getTextInputValue('vm_input_limit').trim();
                const limit = parseInt(limitStr, 10);
                if (isNaN(limit) || limit < 0 || limit > 99) {
                    return interaction.reply({ content: '❌ Invalid number. Please enter a value between 0 and 99.', ephemeral: true });
                }

                await voiceChannel.setUserLimit(limit);
                saveUserVoiceSettings(interaction.user.id, { customLimit: limit });
                return interaction.reply({
                    content: limit === 0 ? '👥 User limit removed (unlimited).' : `👥 User limit set to **${limit}** member(s). *(Saved across servers)*`,
                    ephemeral: true
                });
            }
        }

        // --- Handle Button Interactions ---
        if (!interaction.isButton() || !interaction.customId.startsWith('vm_')) return;

        const voiceChannel = interaction.channel?.isVoiceBased?.()
            ? interaction.channel
            : interaction.member.voice?.channel;

        if (!voiceChannel) {
            return interaction.reply({
                content: '⚠️ You must be connected to an active temporary voice room to use the control interface.',
                ephemeral: true
            });
        }

        const record = getVoiceRecord(voiceChannel.id);
        if (!record) {
            return interaction.reply({
                content: '⚠️ This channel is not an active temporary voice room.',
                ephemeral: true
            });
        }

        const isOwner = record.ownerId === interaction.user.id;

        // Claim button can be pressed by any member in the room if owner has left
        if (interaction.customId === 'vm_claim') {
            const currentOwnerInRoom = voiceChannel.members.get(record.ownerId);
            if (currentOwnerInRoom && record.ownerId !== interaction.user.id) {
                return interaction.reply({
                    content: `⚠️ The channel owner (<@${record.ownerId}>) is still currently inside this room.`,
                    ephemeral: true
                });
            }

            db.prepare('UPDATE voice_channels SET ownerId = ? WHERE channelId = ?')
                .run(interaction.user.id, voiceChannel.id);
            db.prepare('UPDATE voicemaster_channels SET ownerId = ? WHERE channelId = ?')
                .run(interaction.user.id, voiceChannel.id);

            return interaction.reply({
                content: `👑 You have claimed ownership of **${voiceChannel.name}**!`,
                ephemeral: true
            });
        }

        // Info button can be used by anyone in the room
        if (interaction.customId === 'vm_info') {
            const embed = new EmbedBuilder()
                .setTitle(`🔊 ${voiceChannel.name}`)
                .addFields(
                    { name: 'Host / Owner', value: `<@${record.ownerId}>`, inline: true },
                    { name: 'Participants', value: `${voiceChannel.members.size} / ${voiceChannel.userLimit || '∞'}`, inline: true },
                    { name: 'Bitrate', value: `${voiceChannel.bitrate / 1000} kbps`, inline: true }
                )
                .setColor(0x5865F2)
                .setFooter({ text: 'Temporary Voice Room Details' });

            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // All other actions require host ownership
        if (!isOwner) {
            return interaction.reply({
                content: `🔒 You do not own this voice room. Only the room host (<@${record.ownerId}>) can modify these settings.`,
                ephemeral: true
            });
        }

        if (interaction.customId === 'vm_lock') {
            await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false });
            return interaction.reply({ content: '🔒 Room has been **locked**.', ephemeral: true });
        }

        if (interaction.customId === 'vm_unlock') {
            await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: null });
            return interaction.reply({ content: '🔓 Room has been **unlocked**.', ephemeral: true });
        }

        if (interaction.customId === 'vm_ghost') {
            await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false });
            return interaction.reply({ content: '👁️ Room is now **hidden** (ghosted) from others.', ephemeral: true });
        }

        if (interaction.customId === 'vm_unhide') {
            await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: null });
            return interaction.reply({ content: '👁️‍🗨️ Room visibility has been **restored**.', ephemeral: true });
        }

        if (interaction.customId === 'vm_rename') {
            const modal = new ModalBuilder()
                .setCustomId('vm_modal_rename')
                .setTitle('Rename Voice Room');

            const nameInput = new TextInputBuilder()
                .setCustomId('vm_input_name')
                .setLabel('New Channel Name')
                .setStyle(TextInputStyle.Short)
                .setValue(voiceChannel.name)
                .setMaxLength(32)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
            return interaction.showModal(modal);
        }

        if (interaction.customId === 'vm_limit') {
            const modal = new ModalBuilder()
                .setCustomId('vm_modal_limit')
                .setTitle('Set User Limit');

            const limitInput = new TextInputBuilder()
                .setCustomId('vm_input_limit')
                .setLabel('User Limit (0 for unlimited, 1-99)')
                .setStyle(TextInputStyle.Short)
                .setValue(String(voiceChannel.userLimit || 0))
                .setMaxLength(2)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(limitInput));
            return interaction.showModal(modal);
        }
    },
};
