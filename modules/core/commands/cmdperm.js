import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { SettingsManager } from '../../../lib/settings.js';

function normalizeCommandRoleIds(rawValue) {
    if (typeof SettingsManager.normalizeCommandRoles === 'function') {
        return SettingsManager.normalizeCommandRoles(rawValue);
    }
    if (rawValue === null || rawValue === undefined) return [];
    const list = Array.isArray(rawValue) ? rawValue : (typeof rawValue === 'string' ? [rawValue] : []);
    const seen = new Set();
    const normalized = [];
    for (const item of list) {
        if (typeof item !== 'string') continue;
        const cleaned = item.trim().replace(/^["']|["']$/g, '').trim();
        if (cleaned && !seen.has(cleaned)) {
            seen.add(cleaned);
            normalized.push(cleaned);
        }
    }
    return normalized;
}

export default {
    data: new SlashCommandBuilder()
        .setName('cmdperm')
        .setDescription('Configure required roles for executing specific commands (defaults to Everyone).')
        .addSubcommand(sub =>
            sub.setName('set')
                .setDescription('Require one or more roles to execute a command.')
                .addStringOption(opt =>
                    opt.setName('command')
                        .setDescription('The name of the command (e.g. ban, userinfo, voice lock)')
                        .setRequired(true))
                .addRoleOption(opt =>
                    opt.setName('role')
                        .setDescription('The primary role required to use this command')
                        .setRequired(true))
                .addRoleOption(opt =>
                    opt.setName('role2')
                        .setDescription('Additional allowed role (optional)')
                        .setRequired(false))
                .addRoleOption(opt =>
                    opt.setName('role3')
                        .setDescription('Additional allowed role (optional)')
                        .setRequired(false))
                .addRoleOption(opt =>
                    opt.setName('role4')
                        .setDescription('Additional allowed role (optional)')
                        .setRequired(false))
                .addRoleOption(opt =>
                    opt.setName('role5')
                        .setDescription('Additional allowed role (optional)')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Add an allowed role to a command.')
                .addStringOption(opt =>
                    opt.setName('command')
                        .setDescription('The name of the command (e.g. ban, voice lock)')
                        .setRequired(true))
                .addRoleOption(opt =>
                    opt.setName('role')
                        .setDescription('The role to add to this command')
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove an allowed role from a command.')
                .addStringOption(opt =>
                    opt.setName('command')
                        .setDescription('The name of the command (e.g. ban, voice lock)')
                        .setRequired(true))
                .addRoleOption(opt =>
                    opt.setName('role')
                        .setDescription('The role to remove from this command')
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('clear')
                .setDescription('Reset a command to its default permissions (Everyone / Default).')
                .addStringOption(opt =>
                    opt.setName('command')
                        .setDescription('The name of the command to reset')
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all custom command role permissions in this server.'))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;
        const rawCommandRoles = SettingsManager.getGuildJson(guildId, 'command_roles', {});
        const commandRoles = (rawCommandRoles && typeof rawCommandRoles === 'object' && !Array.isArray(rawCommandRoles))
            ? { ...rawCommandRoles }
            : {};

        if (subcommand === 'set') {
            const rawCmd = interaction.options.getString('command').trim().toLowerCase().replace(/^\//, '').replace(/\s+/g, ' ');
            const roleOptionNames = ['role', 'role2', 'role3', 'role4', 'role5'];
            const seenIds = new Set();
            const roleIds = [];

            for (const optName of roleOptionNames) {
                const r = interaction.options.getRole(optName);
                if (r && r.id && !seenIds.has(r.id)) {
                    seenIds.add(r.id);
                    roleIds.push(r.id);
                }
            }

            commandRoles[rawCmd] = roleIds.length === 1 ? roleIds[0] : roleIds;
            SettingsManager.setGuildJson(guildId, 'command_roles', commandRoles);

            if (roleIds.length === 1) {
                return interaction.reply({
                    content: `🔒 Configured permission: The \`/${rawCmd}\` command now requires the <@&${roleIds[0]}> role to execute.`,
                    ephemeral: true
                });
            }

            return interaction.reply({
                content: `🔒 Configured permission: The \`/${rawCmd}\` command now requires one of the following roles to execute: ${roleIds.map(id => `<@&${id}>`).join(', ')}.`,
                ephemeral: true
            });
        }

        if (subcommand === 'add') {
            const rawCmd = interaction.options.getString('command').trim().toLowerCase().replace(/^\//, '').replace(/\s+/g, ' ');
            const role = interaction.options.getRole('role');
            const existing = normalizeCommandRoleIds(commandRoles[rawCmd]);
            const updated = normalizeCommandRoleIds([...existing, role.id]);

            commandRoles[rawCmd] = updated;
            SettingsManager.setGuildJson(guildId, 'command_roles', commandRoles);

            return interaction.reply({
                content: `🔒 Updated permission: Added <@&${role.id}> to \`/${rawCmd}\`. Allowed roles: ${updated.map(id => `<@&${id}>`).join(', ')}.`,
                ephemeral: true
            });
        }

        if (subcommand === 'remove') {
            const rawCmd = interaction.options.getString('command').trim().toLowerCase().replace(/^\//, '').replace(/\s+/g, ' ');
            const role = interaction.options.getRole('role');
            const existing = normalizeCommandRoleIds(commandRoles[rawCmd]);

            if (!existing.includes(role.id)) {
                return interaction.reply({
                    content: `ℹ️ The <@&${role.id}> role is not currently configured for \`/${rawCmd}\`.`,
                    ephemeral: true
                });
            }

            const remaining = existing.filter(id => id !== role.id);
            if (remaining.length === 0) {
                delete commandRoles[rawCmd];
                SettingsManager.setGuildJson(guildId, 'command_roles', commandRoles);
                return interaction.reply({
                    content: `🔓 Removed <@&${role.id}> from \`/${rawCmd}\`. Reset to default permissions (Everyone / Default).`,
                    ephemeral: true
                });
            }

            commandRoles[rawCmd] = remaining;
            SettingsManager.setGuildJson(guildId, 'command_roles', commandRoles);
            return interaction.reply({
                content: `🔒 Removed <@&${role.id}> from \`/${rawCmd}\`. Remaining allowed roles: ${remaining.map(id => `<@&${id}>`).join(', ')}.`,
                ephemeral: true
            });
        }

        if (subcommand === 'clear') {
            const rawCmd = interaction.options.getString('command').trim().toLowerCase().replace(/^\//, '').replace(/\s+/g, ' ');
            const existing = normalizeCommandRoleIds(commandRoles[rawCmd]);

            if (!commandRoles[rawCmd] && existing.length === 0) {
                return interaction.reply({
                    content: `ℹ️ The \`/${rawCmd}\` command does not currently have a custom role requirement.`,
                    ephemeral: true
                });
            }

            delete commandRoles[rawCmd];
            SettingsManager.setGuildJson(guildId, 'command_roles', commandRoles);

            return interaction.reply({
                content: `🔓 Reset \`/${rawCmd}\` to default permissions (Everyone / Default).`,
                ephemeral: true
            });
        }

        if (subcommand === 'list') {
            const entries = Object.entries(commandRoles)
                .map(([cmd, rawVal]) => [cmd, normalizeCommandRoleIds(rawVal)])
                .filter(([, roleIds]) => roleIds.length > 0);

            if (entries.length === 0) {
                return interaction.reply({
                    content: 'ℹ️ No custom command role permissions have been configured yet. All commands are using their default permissions.',
                    ephemeral: true
                });
            }

            const listLines = entries.map(([cmd, roleIds]) => {
                const mentions = roleIds.map(id => `<@&${id}>`).join(', ');
                return `• \`/${cmd}\` → Requires ${mentions}`;
            });

            const embedColor = typeof SettingsManager.getEmbedColor === 'function'
                ? SettingsManager.getEmbedColor(guildId, 'core', 0x5865F2)
                : 0x5865F2;

            const embed = new EmbedBuilder()
                .setTitle(`🛡️ Custom Command Permissions (${entries.length})`)
                .setDescription(listLines.join('\n'))
                .setColor(embedColor)
                .setFooter({ text: `${interaction.guild.name} • Server Administrators can always use all commands` })
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }
    },
};
