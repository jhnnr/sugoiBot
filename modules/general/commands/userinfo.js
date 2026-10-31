import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import db from '../../../lib/database.js';
import { Member } from '../../../lib/classes/Member.js';

export default {
    data: new SlashCommandBuilder()
        .setName('userinfo')
        .setDescription('View detailed server and profile telemetry for a user.')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('The user to inspect (defaults to yourself)')
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used inside a server.', ephemeral: true });
        }

        const targetUser = interaction.options.getUser('user') || interaction.user;
        const targetMember = interaction.options.getMember('user') 
            || (targetUser.id === interaction.user.id ? interaction.member : await interaction.guild.members.fetch(targetUser.id).catch(() => null));

        const guild = interaction.guild;

        // 1. Inviter Lookup
        let inviterDisplay = 'Unknown / Pre-dates tracking / Vanity URL';
        try {
            const inviteRow = db.prepare('SELECT inviterId, inviteCode FROM member_invites WHERE guildId = ? AND userId = ?').get(guild.id, targetUser.id);
            if (inviteRow && inviteRow.inviterId) {
                inviterDisplay = `<@${inviteRow.inviterId}> (Code: \`${inviteRow.inviteCode || 'N/A'}\`)`;
            }
        } catch {}

        // 2. Roles & Permissions
        const rawRoles = targetMember?.roles?.cache
            ? (typeof targetMember.roles.cache.values === 'function' ? Array.from(targetMember.roles.cache.values()) : Array.from(targetMember.roles.cache))
            : [];

        const rolesArray = rawRoles
            .filter(r => r && r.id !== guild.id)
            .sort((a, b) => (b.position || 0) - (a.position || 0));

        const rolesDisplay = rolesArray.length > 0
            ? (rolesArray.length > 12 ? `${rolesArray.slice(0, 12).map(r => `<@&${r.id}>`).join(' ')} ...+${rolesArray.length - 12} more` : rolesArray.map(r => `<@&${r.id}>`).join(' '))
            : 'None';

        const highestRole = targetMember?.roles?.highest?.id && targetMember.roles.highest.id !== guild.id
            ? `<@&${targetMember.roles.highest.id}>`
            : 'None';

        const keyPerms = [];
        if (targetMember?.permissions) {
            if (targetMember.permissions.has(PermissionFlagsBits.Administrator)) keyPerms.push('Administrator');
            if (targetMember.permissions.has(PermissionFlagsBits.ManageGuild)) keyPerms.push('Manage Server');
            if (targetMember.permissions.has(PermissionFlagsBits.ManageRoles)) keyPerms.push('Manage Roles');
            if (targetMember.permissions.has(PermissionFlagsBits.ManageChannels)) keyPerms.push('Manage Channels');
            if (targetMember.permissions.has(PermissionFlagsBits.KickMembers)) keyPerms.push('Kick');
            if (targetMember.permissions.has(PermissionFlagsBits.BanMembers)) keyPerms.push('Ban');
            if (targetMember.permissions.has(PermissionFlagsBits.ModerateMembers)) keyPerms.push('Timeout');
        }
        const permsDisplay = keyPerms.length > 0 ? keyPerms.join(', ') : 'Standard';

        // 3. Leveling & Economy Data
        let xpDisplay = 'N/A';
        let economyDisplay = '0 coins';
        let warningsDisplay = '0';

        if (targetMember) {
            try {
                const mem = new Member(targetMember);
                const xpData = mem.getXP();
                const rank = mem.getRank();
                xpDisplay = `Level **${xpData.level}** (${xpData.xp.toLocaleString()} XP • Server Rank #${rank})`;
                economyDisplay = `${mem.getBalance().toLocaleString()} coins`;
                warningsDisplay = `${mem.getWarnings().length}`;
            } catch {}
        }

        // 4. Presence & Activity
        const presence = targetMember?.presence;
        const statusMap = {
            online: '🟢 Online',
            idle: '🟡 Idle',
            dnd: '🔴 Do Not Disturb',
            offline: '⚪ Offline / Invisible'
        };
        const statusDisplay = statusMap[presence?.status] || '⚪ Offline';
        const activity = presence?.activities?.[0]?.name ? `🎮 Playing **${presence.activities[0].name}**` : 'None';

        // Build Telemetry Embed
        const embedColor = targetMember?.displayHexColor && targetMember.displayHexColor !== '#000000'
            ? targetMember.displayHexColor
            : 0x5865F2;

        const embed = new EmbedBuilder()
            .setTitle(`👤 User Info: ${targetUser.username}`)
            .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
            .setColor(embedColor)
            .addFields(
                {
                    name: '🆔 Identity',
                    value: `• **Tag**: ${targetUser.tag}\n• **Mention**: <@${targetUser.id}>\n• **User ID**: \`${targetUser.id}\`\n• **Account Type**: ${targetUser.bot ? '🤖 Bot' : '👤 User'}\n• **Nickname**: ${targetMember?.nickname || 'None'}`,
                    inline: false
                },
                {
                    name: '📅 Dates & Join Details',
                    value: `• **Created Discord**: <t:${Math.floor(targetUser.createdTimestamp / 1000)}:F> (<t:${Math.floor(targetUser.createdTimestamp / 1000)}:R>)\n• **Joined Server**: ${targetMember?.joinedTimestamp ? `<t:${Math.floor(targetMember.joinedTimestamp / 1000)}:F> (<t:${Math.floor(targetMember.joinedTimestamp / 1000)}:R>)` : 'Unknown'}\n• **Invited By**: ${inviterDisplay}`,
                    inline: false
                },
                {
                    name: '🛡️ Server Standing & Roles',
                    value: `• **Highest Role**: ${highestRole}\n• **Roles (${rolesArray.length})**: ${rolesDisplay}\n• **Key Permissions**: ${permsDisplay}`,
                    inline: false
                },
                {
                    name: '📊 Server Stats',
                    value: `• **XP & Level**: ${xpDisplay}\n• **Balance**: 🪙 ${economyDisplay}\n• **Warnings**: ⚠️ ${warningsDisplay}`,
                    inline: false
                },
                {
                    name: '📡 Status & Activity',
                    value: `• **Presence**: ${statusDisplay}\n• **Activity**: ${activity}`,
                    inline: false
                }
            )
            .setFooter({ text: `${guild.name} • Requested by ${interaction.user.tag}` })
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    },
};
