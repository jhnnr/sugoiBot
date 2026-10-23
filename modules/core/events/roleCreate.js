import { Events, AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { loggingService } from '../../../lib/bot/loggingService.js';

export default {
    name: Events.GuildRoleCreate,
    async execute(role) {
        if (!role.guild) return;

        const guild = role.guild;
        let creator = null;

        if (guild.members?.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog)) {
            try {
                const logs = await guild.fetchAuditLogs({
                    type: AuditLogEvent.RoleCreate,
                    limit: 1
                }).catch(() => null);

                const entry = logs?.entries?.first();
                if (entry && (entry.targetId === role.id || Date.now() - entry.createdTimestamp < 3500)) {
                    creator = entry.executor;
                }
            } catch (err) {}
        }

        await loggingService.log(guild, {
            description: `🛡️ Role created: **${role.name}** (\`${role.id}\`)`,
            color: 0x57F287,
            eventType: 'log_events_roles',
            user: creator
        });
    },
};
