import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActivityType } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../../../lib/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultWhitelistPath = path.join(__dirname, '..', 'defaultWhitelist.json');
let defaultWhitelist = {};
try {
    defaultWhitelist = JSON.parse(fs.readFileSync(defaultWhitelistPath, 'utf8'));
} catch {}

export default {
    data: new SlashCommandBuilder()
        .setName('gamerole')
        .setDescription('Manage the GameRole game whitelist and presence role automation.')
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Add a game to the GameRole whitelist.')
                .addStringOption(opt =>
                    opt.setName('game')
                        .setDescription('Exact name of the game (as shown in Discord presence)')
                        .setRequired(true))
                .addStringOption(opt =>
                    opt.setName('custom_role')
                        .setDescription('Custom role name to assign (defaults to game name)')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('addmygame')
                .setDescription('Add the game you are currently playing to the whitelist.'))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a game from the GameRole whitelist.')
                .addStringOption(opt =>
                    opt.setName('game')
                        .setDescription('Name of the game to remove')
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all whitelisted games for this server.'))
        .addSubcommand(sub =>
            sub.setName('info')
                .setDescription('Display GameRole module information and status.'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        if (subcommand === 'add') {
            const gameName = interaction.options.getString('game').trim();
            const customRole = interaction.options.getString('custom_role')?.trim() || gameName;

            db.prepare(`
                INSERT INTO gamerole_whitelist (guildId, gameName, roleName)
                VALUES (?, ?, ?)
                ON CONFLICT(guildId, gameName) DO UPDATE SET roleName = excluded.roleName
            `).run(guildId, gameName, customRole);

            return interaction.reply({
                content: `Added **${gameName}** to the GameRole whitelist (Role: \`PLAYING ${customRole}\`).`,
                ephemeral: true
            });
        }

        if (subcommand === 'addmygame') {
            const presence = interaction.member?.presence;
            const activity = presence?.activities?.find(a => a.type === ActivityType.Playing);

            if (!activity || !activity.name) {
                return interaction.reply({
                    content: 'You are not currently playing a game according to your Discord status.',
                    ephemeral: true
                });
            }

            const gameName = activity.name.trim();
            db.prepare(`
                INSERT INTO gamerole_whitelist (guildId, gameName, roleName)
                VALUES (?, ?, ?)
                ON CONFLICT(guildId, gameName) DO UPDATE SET roleName = excluded.roleName
            `).run(guildId, gameName, gameName);

            return interaction.reply({
                content: `Detected your current game: **${gameName}**! Added to the whitelist (Role: \`PLAYING ${gameName}\`).`,
                ephemeral: true
            });
        }

        if (subcommand === 'remove') {
            const gameName = interaction.options.getString('game').trim();
            const result = db.prepare('DELETE FROM gamerole_whitelist WHERE guildId = ? AND LOWER(gameName) = LOWER(?)').run(guildId, gameName);

            if (result.changes === 0) {
                return interaction.reply({
                    content: `**${gameName}** was not found in this server's whitelist.`,
                    ephemeral: true
                });
            }

            return interaction.reply({
                content: `Removed **${gameName}** from the GameRole whitelist.`,
                ephemeral: true
            });
        }

        if (subcommand === 'list') {
            const rows = db.prepare('SELECT gameName, roleName FROM gamerole_whitelist WHERE guildId = ? ORDER BY gameName ASC').all(guildId);
            const defaultGames = Object.keys(defaultWhitelist);

            let description = '';
            if (rows.length > 0) {
                description += `**Server Custom Whitelist (${rows.length}):**\n` +
                    rows.map((r, i) => `• ${r.gameName} → \`PLAYING ${r.roleName}\``).join('\n') + '\n\n';
            }

            description += `**Global Built-in Whitelist (${defaultGames.length} games):**\n` +
                defaultGames.slice(0, 30).map(g => `• ${g}`).join('\n') +
                (defaultGames.length > 30 ? `\n*...and ${defaultGames.length - 30} more games.*` : '');

            const embed = new EmbedBuilder()
                .setTitle(`🎮 GameRole Whitelist`)
                .setDescription(description.slice(0, 4000))
                .setColor(0x5865F2)
                .setFooter({ text: `${interaction.guild.name} • Total ${rows.length + defaultGames.length} active games` })
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        if (subcommand === 'info') {
            const rowCount = db.prepare('SELECT COUNT(*) as count FROM gamerole_whitelist WHERE guildId = ?').get(guildId)?.count || 0;

            const embed = new EmbedBuilder()
                .setTitle('🎮 GameRole Module')
                .setDescription('Automatically creates and assigns roles to members based on the game they are currently playing via Discord Rich Presence.')
                .addFields(
                    { name: 'Whitelisted Games', value: `${rowCount} games registered`, inline: true },
                    { name: 'Role Prefix', value: '`PLAYING `', inline: true },
                    { name: 'How It Works', value: 'When a member starts playing a whitelisted game, the bot checks for a corresponding role, creates it if needed, and assigns it. When they stop or switch games, the role is cleaned up automatically.' }
                )
                .setColor(0xED4245)
                .setFooter({ text: 'Inspired by jhnnr/GameRole' });

            return interaction.reply({ embeds: [embed] });
        }
    },
};
