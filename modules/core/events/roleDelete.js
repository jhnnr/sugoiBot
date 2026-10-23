import { Events, AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { loggingService } from '../../../lib/bot/loggingService.js';

export default {
    name: Events.GuildRoleDelete,
    async execute(role) {
        if (!role.guild) return;

        const guild = role.guild;
        let deleter = null;

        if (guild.members?.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog)) {
            try {
                const logs = await guild.fetchAuditLogs({
                    type: AuditLogEvent.RoleDelete,
                    limit: 1
                }).catch(() => null);

                const entry = logs?.entries?.first();
                if (entry && (entry.targetId === role.id || Date.now() - entry.createdTimestamp < 3500)) {
                    deleter = entry.executor;
                }
            } catch (err) {}
        }

        await loggingService.log(guild, {
            description: `🗑️ Role deleted: **${role.name}** (\`${role.id}\`)`,
            color: 0xED4245,
            eventType: 'log_events_roles',
            user: deleter
        });
    },
};
