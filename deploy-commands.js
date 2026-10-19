import dotenv from 'dotenv';
import { REST, Routes } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config();

export async function deployCommands() {
    const commands = [];
    const modulesPath = path.join(process.cwd(), 'modules');
    
    if (!fs.existsSync(modulesPath)) return;

    const modules = fs.readdirSync(modulesPath).filter(f => 
        fs.statSync(path.join(modulesPath, f)).isDirectory()
    );

    for (const moduleName of modules) {
        const commandsPath = path.join(modulesPath, moduleName, 'commands');
        if (fs.existsSync(commandsPath)) {
            const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
            for (const file of commandFiles) {
                const commandUrl = pathToFileURL(path.join(commandsPath, file)).href;
                const command = (await import(commandUrl)).default;
                if (command.data) {
                    commands.push(command.data.toJSON());
                }
            }
        }
    }

    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    const clientId = process.env.CLIENT_ID?.trim()?.replace(/^["']|["']$/g, '');
    const guildId = process.env.GUILD_ID?.trim()?.replace(/^["']|["']$/g, '');

    if (!clientId) {
        console.error('[ERROR] Cannot deploy commands: CLIENT_ID is not configured.');
        return;
    }

    try {
        console.log(`Started refreshing ${commands.length} application (/) commands.`);

        // Discord's PUT endpoint atomically replaces all commands in one request without rate-limit stalls
        if (guildId && guildId !== 'your_test_guild_id_here') {
            await rest.put(
                Routes.applicationGuildCommands(clientId, guildId),
                { body: commands },
            );
            console.log(`Successfully deployed ${commands.length} application (/) commands to guild ${guildId}.`);
        } else {
            await rest.put(
                Routes.applicationCommands(clientId),
                { body: commands },
            );
            console.log(`Successfully reloaded ${commands.length} application (/) commands globally.`);
        }
    } catch (error) {
        console.error('Error deploying commands:', error);
    }
}

// Allow running directly
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    deployCommands();
}
