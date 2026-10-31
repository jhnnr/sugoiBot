import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { SettingsManager } from '../../../lib/settings.js';

export default {
    data: new SlashCommandBuilder()
        .setName('cmdperm')
        .setDescription('Configure required roles for executing specific commands (defaults to Everyone).')
        .addSubcommand(sub =>
            sub.setName('set')
                .setDescription('Require a specific role to execute a command.')
                .addStringOption(opt =>
                    opt.setName('command')
                        .setDescription('The name of the command (e.g. ban, userinfo, kick, coinflip)')
                        .setRequired(true))
                .addRoleOption(opt =>
                    opt.setName('role')
                        .setDescription('The role required to use this command')
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
        const commandRoles = SettingsManager.getGuildJson(guildId, 'command_roles', {});

        if (subcommand === 'set') {
            const rawCmd = interaction.options.getString('command').trim().toLowerCase().replace(/^\//, '');
            const role = interaction.options.getRole('role');

            commandRoles[rawCmd] = role.id;
            SettingsManager.setGuildJson(guildId, 'command_roles', commandRoles);

            return interaction.reply({
                content: `🔒 Configured permission: The \`/${rawCmd}\` command now requires the ${role} role to execute.`,
                ephemeral: true
            });
        }

        if (subcommand === 'clear') {
            const rawCmd = interaction.options.getString('command').trim().toLowerCase().replace(/^\//, '');

            if (!commandRoles[rawCmd]) {
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
            const entries = Object.entries(commandRoles);

            if (entries.length === 0) {
                return interaction.reply({
                    content: 'ℹ️ No custom command role permissions have been configured yet. All commands are using their default permissions.',
                    ephemeral: true
                });
            }

            const listLines = entries.map(([cmd, roleId]) => {
                return `• \`/${cmd}\` &rarr; Requires <@&${roleId}> (\`${roleId}\`)`;
            });

            const embed = new EmbedBuilder()
                .setTitle(`🛡️ Custom Command Permissions (${entries.length})`)
                .setDescription(listLines.join('\n'))
                .setColor(0x5865F2)
                .setFooter({ text: `${interaction.guild.name} • Server Administrators can always use all commands` })
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }
    },
};
