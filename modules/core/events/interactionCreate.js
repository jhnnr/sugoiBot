import { Events, Collection } from 'discord.js';
import { SettingsManager } from '../../../lib/settings.js';
import { loggingService } from '../../../lib/bot/loggingService.js';

function getFullCommandString(interaction) {
    const parts = [`/${interaction.commandName}`];

    function extractOptions(optionsList) {
        if (!optionsList || !Array.isArray(optionsList)) return;
        for (const opt of optionsList) {
            // Type 1: Subcommand, Type 2: SubcommandGroup
            if (opt.type === 1 || opt.type === 2) {
                parts.push(opt.name);
                if (opt.options) extractOptions(opt.options);
            } else {
                let val = opt.value;
                if (opt.user) {
                    val = `@${opt.user.tag || opt.user.username}`;
                } else if (opt.channel) {
                    val = `#${opt.channel.name}`;
                } else if (opt.role) {
                    val = `@${opt.role.name}`;
                }
                parts.push(`${opt.name}:${val}`);
            }
        }
    }

    if (interaction.options?.data) {
        extractOptions(interaction.options.data);
    }

    return parts.join(' ');
}

export default {
    name: Events.InteractionCreate,
    async execute(interaction) {
        if (!interaction.isChatInputCommand()) return;

        const { client } = interaction;
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        // Check if module is disabled in this server
        if (interaction.guild && command.module && command.module !== 'core') {
            let isModuleEnabled = SettingsManager.getGuildJson(
                interaction.guild.id,
                `module_${command.module}_enabled`,
                true
            );

            if (command.module === 'voice' && isModuleEnabled) {
                const legacyModule = SettingsManager.getGuildJson(interaction.guild.id, 'module_voicemaster_enabled', true);
                const voiceActive = SettingsManager.getGuildJson(interaction.guild.id, 'voice_enabled', true);
                const legacyVoice = SettingsManager.getGuildJson(interaction.guild.id, 'voicemaster_enabled', true);
                if (!legacyModule || !voiceActive || !legacyVoice) {
                    isModuleEnabled = false;
                }
            }

            if (!isModuleEnabled) {
                return interaction.reply({
                    content: `The **${command.module}** module is currently disabled in this server.`,
                    ephemeral: true
                });
            }
        }

        // Cooldown logic
        const { cooldowns } = client;

        if (!cooldowns.has(command.data.name)) {
            cooldowns.set(command.data.name, new Collection());
        }

        const now = Date.now();
        const timestamps = cooldowns.get(command.data.name);
        const defaultCooldownDuration = 3;
        const cooldownAmount = (command.cooldown ?? defaultCooldownDuration) * 1000;

        if (timestamps.has(interaction.user.id)) {
            const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;

            if (now < expirationTime) {
                const expiredTimestamp = Math.round(expirationTime / 1000);
                return interaction.reply({
                    content: `Please wait, you are on a cooldown for \`${command.data.name}\`. You can use it again <t:${expiredTimestamp}:R>.`,
                    ephemeral: true
                });
            }
        }

        timestamps.set(interaction.user.id, now);
        setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

        try {
            await command.execute(interaction);

            if (interaction.guild) {
                const fullCommand = getFullCommandString(interaction);
                loggingService.log(interaction.guild, {
                    description: `⚡ ${interaction.user} used \`${fullCommand}\` in ${interaction.channel}`,
                    color: 0x5865F2,
                    eventType: 'log_events_commands',
                    user: interaction.user
                }).catch(() => {});
            }
        } catch (error) {
            client.logger.error(`Error executing command ${interaction.commandName}:`, error);
            const reply = { content: 'There was an error while executing this command!', ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(reply);
            } else {
                await interaction.reply(reply);
            }
        }
    },
};
