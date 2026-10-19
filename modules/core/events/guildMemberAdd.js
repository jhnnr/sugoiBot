import { Events } from 'discord.js';
import { loggingService } from '../../../lib/bot/loggingService.js';
import { SettingsManager } from '../../../lib/settings.js';

export default {
    name: Events.GuildMemberAdd,
    async execute(member) {
        if (!member.guild) return;

        const { guild } = member;
        let inviterInfo = 'Unknown / Vanity URL / Direct Link';
        let inviteCode = null;

        try {
            const cachedInvites = member.client.invites?.get(guild.id) || new Map();
            const newInvites = await guild.invites.fetch().catch(() => null);

            if (newInvites) {
                const inviteValues = typeof newInvites.values === 'function' ? Array.from(newInvites.values()) : newInvites;
                // Find which invite has an incremented usage count
                const usedInvite = inviteValues.find(inv => {
                    const prevUses = cachedInvites.get(inv.code) ?? 0;
                    return (inv.uses ?? 0) > prevUses;
                });

                // Refresh cache
                member.client.invites.set(guild.id, new Map(inviteValues.map(inv => [inv.code, inv.uses ?? 0])));

                if (usedInvite) {
                    inviteCode = usedInvite.code;
                    if (usedInvite.inviter) {
                        inviterInfo = `${usedInvite.inviter.tag} (<@${usedInvite.inviter.id}>)`;
                    } else {
                        inviterInfo = 'Server Vanity / System Invite';
                    }
                }
            }
        } catch (error) {
            // Guild might not have Manage Guild permissions granted to the bot
        }

        const fields = [
            { name: '👤 Member', value: `${member.user.tag} (<@${member.id}>)`, inline: true },
            { name: '📨 Invited By', value: inviterInfo, inline: true }
        ];

        if (inviteCode) {
            fields.push({ name: '🔗 Invite Code', value: `\`${inviteCode}\``, inline: true });
        }

        fields.push({
            name: '📅 Account Created',
            value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
            inline: true
        });

        await loggingService.log(guild, {
            title: 'Member Joined',
            description: `${member.user.tag} joined the server.`,
            color: 0x57F287,
            eventType: 'log_events_member_join',
            user: member.user,
            fields
        });
    },
};
