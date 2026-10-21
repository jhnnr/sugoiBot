import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { SettingsManager } from '../../../lib/settings.js';

export default {
    data: new SlashCommandBuilder()
        .setName('setreward')
        .setDescription('Configure role rewards earned at specific levels.')
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Assign a role reward to a specific level.')
                .addIntegerOption(opt =>
                    opt.setName('level')
                        .setDescription('The level required to earn the role')
                        .setMinValue(1)
                        .setRequired(true))
                .addRoleOption(opt =>
                    opt.setName('role')
                        .setDescription('The role to award')
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove the role reward for a specific level.')
                .addIntegerOption(opt =>
                    opt.setName('level')
                        .setDescription('The level whose role reward should be removed')
                        .setMinValue(1)
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all configured level role rewards for this server.'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;
        const rewards = SettingsManager.getGuildJson(guildId, 'role_rewards', {});

        if (subcommand === 'add') {
            const level = interaction.options.getInteger('level');
            const role = interaction.options.getRole('role');

            rewards[String(level)] = role.id;
            SettingsManager.setGuildJson(guildId, 'role_rewards', rewards);

            return interaction.reply({
                content: `🎉 Configured role reward: Members reaching **Level ${level}** will receive the ${role} role!`,
                ephemeral: true
            });
        }

        if (subcommand === 'remove') {
            const level = interaction.options.getInteger('level');
            const levelKey = String(level);

            if (!rewards[levelKey]) {
                return interaction.reply({
                    content: `⚠️ No role reward is currently configured for **Level ${level}**.`,
                    ephemeral: true
                });
            }

            delete rewards[levelKey];
            SettingsManager.setGuildJson(guildId, 'role_rewards', rewards);

            return interaction.reply({
                content: `✅ Removed the role reward for **Level ${level}**.`,
                ephemeral: true
            });
        }

        if (subcommand === 'list') {
            const entries = Object.entries(rewards).sort((a, b) => Number(a[0]) - Number(b[0]));

            if (entries.length === 0) {
                return interaction.reply({
                    content: 'No role rewards have been set up for this server yet. Use `/setreward add <level> <role>` to configure one!',
                    ephemeral: true
                });
            }

            const descriptionLines = entries.map(([lvl, roleId]) => {
                return `• **Level ${lvl}** &rarr; <@&${roleId}> (\`${roleId}\`)`;
            });

            const embed = new EmbedBuilder()
                .setTitle(`⭐ Level Role Rewards (${entries.length})`)
                .setDescription(descriptionLines.join('\n'))
                .setColor(0xFEE75C)
                .setFooter({ text: interaction.guild.name })
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }
    },
};
