import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadCommands(client, moduleDir) {
    const commandsPath = path.join(moduleDir, 'commands');
    if (!fs.existsSync(commandsPath)) return;

    const moduleName = path.basename(moduleDir).toLowerCase();
    const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
    for (const file of commandFiles) {
        const commandUrl = pathToFileURL(path.join(commandsPath, file)).href;
        const command = (await import(commandUrl)).default;
        if (command.data && command.execute) {
            command.module = moduleName;
            client.commands.set(command.data.name, command);
        }
    }
}
