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
                .setDescription('Remove or disable a game from the GameRole whitelist.')
                .addStringOption(opt =>
                    opt.setName('game')
                        .setDescription('Name of the game to remove')
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('reset')
                .setDescription('Reset whitelist overrides back to the 84 default games.'))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all whitelisted games for this server.')
                .addIntegerOption(opt =>
                    opt.setName('page')
                        .setDescription('Page number of the whitelist (1-4)')
                        .setMinValue(1)
                        .setMaxValue(4)))
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

            // Check if game exists in default whitelist
            const lowerGame = gameName.toLowerCase();
            const inDefault = Object.keys(defaultWhitelist).some(k => k.toLowerCase() === lowerGame);

            if (inDefault) {
                db.prepare(`
                    INSERT INTO gamerole_whitelist (guildId, gameName, roleName)
                    VALUES (?, ?, '__DISABLED__')
                    ON CONFLICT(guildId, gameName) DO UPDATE SET roleName = '__DISABLED__'
                `).run(guildId, gameName);

                return interaction.reply({
                    content: `Disabled **${gameName}** from the GameRole whitelist for this server.`,
                    ephemeral: true
                });
            }

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

        if (subcommand === 'reset') {
            db.prepare('DELETE FROM gamerole_whitelist WHERE guildId = ?').run(guildId);
            return interaction.reply({
                content: `✅ Reset whitelist for **${interaction.guild.name}**! All 84 default games are now active.`,
                ephemeral: true
            });
        }

        if (subcommand === 'list') {
            const page = interaction.options.getInteger('page') || 1;
            const pageSize = 25;

            const customRows = db.prepare('SELECT gameName, roleName FROM gamerole_whitelist WHERE guildId = ? AND roleName != ? ORDER BY gameName ASC').all(guildId, '__DISABLED__');
            const disabledRows = db.prepare('SELECT gameName FROM gamerole_whitelist WHERE guildId = ? AND roleName = ?').all(guildId, '__DISABLED__');
            const disabledSet = new Set(disabledRows.map(r => r.gameName.toLowerCase()));

            const defaultGames = Object.entries(defaultWhitelist).filter(([k]) => !disabledSet.has(k.toLowerCase()));
            const totalDefaultPages = Math.ceil(defaultGames.length / pageSize) || 1;
            const validPage = Math.min(totalDefaultPages, Math.max(1, page));

            const pageGames = defaultGames.slice((validPage - 1) * pageSize, validPage * pageSize);

            let description = '';
            if (customRows.length > 0 && validPage === 1) {
                description += `**Server Custom Games (${customRows.length}):**\n` +
                    customRows.map((r, i) => `• ${r.gameName} → \`PLAYING ${r.roleName}\``).join('\n') + '\n\n';
            }

            description += `**Default Whitelisted Games (Page ${validPage}/${totalDefaultPages} • ${defaultGames.length} active):**\n` +
                pageGames.map(([k, v]) => `• ${k}${v !== k ? ` → \`PLAYING ${v}\`` : ''}`).join('\n');

            if (disabledRows.length > 0 && validPage === 1) {
                description += `\n\n**Disabled in this server (${disabledRows.length}):**\n` +
                    disabledRows.map(r => `~~${r.gameName}~~`).join(', ');
            }

            const embed = new EmbedBuilder()
                .setTitle(`🎮 GameRole Whitelist`)
                .setDescription(description.slice(0, 4000))
                .setColor(0x5865F2)
                .setFooter({ text: `${interaction.guild.name} • Total ${customRows.length + defaultGames.length} active games • Page ${validPage} of ${totalDefaultPages}` })
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        if (subcommand === 'info') {
            const rowCount = db.prepare('SELECT COUNT(*) as count FROM gamerole_whitelist WHERE guildId = ? AND roleName != ?').get(guildId, '__DISABLED__')?.count || 0;
            const defaultCount = Object.keys(defaultWhitelist).length;

            const embed = new EmbedBuilder()
                .setTitle('🎮 GameRole Module')
                .setDescription('Automatically creates and assigns roles to members based on the game they are currently playing via Discord Rich Presence.')
                .addFields(
                    { name: 'Active Whitelist', value: `${defaultCount + rowCount} games (84 built-in + ${rowCount} custom)`, inline: true },
                    { name: 'Role Prefix', value: '`PLAYING `', inline: true },
                    { name: 'How It Works', value: 'When a member starts playing any whitelisted game, the bot checks for a corresponding role, creates it if needed, and assigns it. When they stop or switch games, the role is removed automatically.' }
                )
                .setColor(0xED4245)
                .setFooter({ text: 'SugoiBot GameRole' });

            return interaction.reply({ embeds: [embed] });
        }
    },
};
