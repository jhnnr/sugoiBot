import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import db from '../../../lib/database.js';
import {
    getVoiceRecord,
    getVoiceHubConfig,
    saveUserVoiceSettings
} from '../lib/voiceHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Manage temporary voice rooms and server voice configuration.')
        .addSubcommand(sub =>
            sub.setName('setup')
                .setDescription('Set up the Join-to-Create temporary voice channel system.'))
        .addSubcommand(sub =>
            sub.setName('info')
                .setDescription('View temporary voice system configuration or current room details.'))
        .addSubcommand(sub =>
            sub.setName('lock')
                .setDescription('Lock your voice room to prevent other members from joining.'))
        .addSubcommand(sub =>
            sub.setName('unlock')
                .setDescription('Unlock your voice room to allow public access.'))
        .addSubcommand(sub =>
            sub.setName('name')
                .setDescription('Rename your temporary voice room.')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('The new name for your voice room')
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('limit')
                .setDescription('Set the maximum user limit for your room.')
                .addIntegerOption(opt =>
                    opt.setName('limit')
                        .setDescription('User limit (0 for unlimited, 1-99)')
                        .setMinValue(0)
                        .setMaxValue(99)
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('claim')
                .setDescription('Claim ownership of this room if the previous host left.'))
        .addSubcommand(sub =>
            sub.setName('permit')
                .setDescription('Allow a specific user to join your locked room.')
                .addUserOption(opt =>
                    opt.setName('user')
                        .setDescription('The user to permit')
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('reject')
                .setDescription('Deny a user access to your room and kick them if inside.')
                .addUserOption(opt =>
                    opt.setName('user')
                        .setDescription('The user to deny')
                        .setRequired(true))),

    async execute(interaction) {
        if (!interaction.guild || !interaction.member) {
            return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();
        const guild = interaction.guild;

        // --- 1. Admin Setup Subcommand ---
        if (subcommand === 'setup') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({
                    content: '❌ You must have **Manage Server** or **Administrator** permissions to run `/voice setup`.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                // 1. Create Category
                const category = await guild.channels.create({
                    name: '🔊 Temporary Voice',
                    type: ChannelType.GuildCategory
                });

                // 2. Create Join-to-Create Hub Voice Channel
                const hubChannel = await guild.channels.create({
                    name: '➕ Join to Create',
                    type: ChannelType.GuildVoice,
                    parent: category.id
                });

                // 3. Store configuration in database
                db.prepare(`
                    INSERT INTO voice_hubs (hubChannelId, guildId, categoryId)
                    VALUES (?, ?, ?)
                    ON CONFLICT(hubChannelId) DO UPDATE SET
                        categoryId = excluded.categoryId
                `).run(hubChannel.id, guild.id, category.id);

                db.prepare(`
                    INSERT INTO voice_guilds (guildId, hubChannelId, categoryId)
                    VALUES (?, ?, ?)
                    ON CONFLICT(guildId) DO UPDATE SET
                        hubChannelId = excluded.hubChannelId,
                        categoryId = excluded.categoryId
                `).run(guild.id, hubChannel.id, category.id);

                return interaction.editReply({
                    content: `✅ Temporary Voice system has been successfully configured!\n\n` +
                        `• **Category**: ${category.name}\n` +
                        `• **Join Channel**: <#${hubChannel.id}>\n\n` +
                        `Members can now hop into <#${hubChannel.id}> to automatically spawn their own private room. The control panel will appear directly in their voice channel's chat box!`
                });
            } catch (error) {
                console.error('[ERROR] Voice setup failed:', error);
                return interaction.editReply({
                    content: `❌ Setup failed: \`${error.message}\`. Make sure the bot has **Manage Channels** permissions.`
                });
            }
        }

        // --- 2. Info Subcommand ---
        if (subcommand === 'info') {
            const voiceChannel = interaction.member.voice?.channel;
            const record = voiceChannel ? getVoiceRecord(voiceChannel.id) : null;

            if (record && voiceChannel) {
                const embed = new EmbedBuilder()
                    .setTitle(`🔊 ${voiceChannel.name}`)
                    .addFields(
                        { name: 'Host / Owner', value: `<@${record.ownerId}>`, inline: true },
                        { name: 'Participants', value: `${voiceChannel.members.size} / ${voiceChannel.userLimit || '∞'}`, inline: true },
                        { name: 'Bitrate', value: `${voiceChannel.bitrate / 1000} kbps`, inline: true }
                    )
                    .setColor(0x5865F2)
                    .setFooter({ text: 'Active Room Details' });

                return interaction.reply({ embeds: [embed], ephemeral: true });
            }

            const allHubs = db.prepare('SELECT * FROM voice_hubs WHERE guildId = ?').all(guild.id);
            const activeRooms = db.prepare('SELECT * FROM voice_channels WHERE guildId = ?').all(guild.id);

            if ((!allHubs || allHubs.length === 0) && (!activeRooms || activeRooms.length === 0)) {
                return interaction.reply({
                    content: '⚠️ Temporary Voice is not configured yet in this server. Run `/voice setup` to deploy the system!',
                    ephemeral: true
                });
            }

            const hubsList = (allHubs && allHubs.length > 0)
                ? allHubs.map((h, i) => `**${i + 1}.** Hub: <#${h.hubChannelId}> (Category: <#${h.categoryId}>)`).join('\n')
                : 'None configured yet.';

            const roomsList = (activeRooms && activeRooms.length > 0)
                ? activeRooms.map(r => `• <#${r.channelId}> • Host: <@${r.ownerId}>`).join('\n')
                : '*No active temporary rooms right now.*';

            const embed = new EmbedBuilder()
                .setTitle('🔊 Temporary Voice Status')
                .addFields(
                    { name: `Configured Hubs (${allHubs.length})`, value: hubsList.slice(0, 1024), inline: false },
                    { name: `Active Temporary Rooms (${activeRooms.length})`, value: roomsList.slice(0, 1024), inline: false },
                    { name: 'Control Panel', value: 'Sent inside each temporary voice room chat box upon creation', inline: false }
                )
                .setColor(0x5865F2)
                .setFooter({ text: guild.name })
                .setTimestamp();

            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // --- 3. Room Management Subcommands ---
        const voiceChannel = interaction.member.voice?.channel;
        if (!voiceChannel) {
            return interaction.reply({
                content: '⚠️ You must be connected to your temporary voice room to use this command.',
                ephemeral: true
            });
        }

        const record = getVoiceRecord(voiceChannel.id);
        if (!record) {
            return interaction.reply({
                content: '⚠️ This channel is not a recognized temporary voice room.',
                ephemeral: true
            });
        }

        const isOwner = record.ownerId === interaction.user.id;

        // Claim logic
        if (subcommand === 'claim') {
            const currentOwnerMember = voiceChannel.members.get(record.ownerId);
            if (currentOwnerMember && record.ownerId !== interaction.user.id) {
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
                content: `👑 You are now the host of **${voiceChannel.name}**!`,
                ephemeral: true
            });
        }

        // All remaining commands require room ownership
        if (!isOwner) {
            return interaction.reply({
                content: `🔒 You do not own this voice room. Only <@${record.ownerId}> can modify its settings.`,
                ephemeral: true
            });
        }

        if (subcommand === 'lock') {
            await voiceChannel.permissionOverwrites.edit(guild.roles.everyone, {
                Connect: false
            });
            return interaction.reply({ content: '🔒 Room has been **locked**. Nobody else can join.', ephemeral: true });
        }

        if (subcommand === 'unlock') {
            await voiceChannel.permissionOverwrites.edit(guild.roles.everyone, {
                Connect: null
            });
            return interaction.reply({ content: '🔓 Room has been **unlocked**. Anyone can join.', ephemeral: true });
        }

        if (subcommand === 'name') {
            const newName = interaction.options.getString('name').trim();
            await voiceChannel.setName(newName);
            saveUserVoiceSettings(interaction.user.id, { customName: newName });
            return interaction.reply({
                content: `✏️ Room renamed to **${newName}**! *(Saved as your default room name across servers)*`,
                ephemeral: true
            });
        }

        if (subcommand === 'limit') {
            const limit = interaction.options.getInteger('limit');
            await voiceChannel.setUserLimit(limit);
            saveUserVoiceSettings(interaction.user.id, { customLimit: limit });
            return interaction.reply({
                content: limit === 0 ? '👥 User limit removed (unlimited).' : `👥 User limit set to **${limit}** member(s). *(Saved across servers)*`,
                ephemeral: true
            });
        }

        if (subcommand === 'permit') {
            const targetUser = interaction.options.getUser('user');
            await voiceChannel.permissionOverwrites.edit(targetUser, {
                Connect: true,
                ViewChannel: true
            });
            return interaction.reply({
                content: `✅ Permitted <@${targetUser.id}> to join this room.`,
                ephemeral: true
            });
        }

        if (subcommand === 'reject') {
            const targetUser = interaction.options.getUser('user');
            if (targetUser.id === interaction.user.id) {
                return interaction.reply({ content: 'You cannot reject yourself from your own room.', ephemeral: true });
            }

            await voiceChannel.permissionOverwrites.edit(targetUser, {
                Connect: false
            });

            const memberInRoom = voiceChannel.members.get(targetUser.id);
            if (memberInRoom) {
                await memberInRoom.voice.disconnect().catch(() => {});
            }

            return interaction.reply({
                content: `🚫 Rejected <@${targetUser.id}> from this room.`,
                ephemeral: true
            });
        }
    },
};
