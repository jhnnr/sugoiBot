import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Generates markdown documentation for all modules and updates mkdocs.yml
 * @param {string} rootDir 
 */
export async function generateDocs(rootDir = process.cwd()) {
    const modulesDir = path.join(rootDir, 'modules');
    const docsDir = path.join(rootDir, 'docs');
    const modulesDocsDir = path.join(docsDir, 'modules');
    const mkdocsPath = path.join(rootDir, 'mkdocs.yml');

    if (!fs.existsSync(modulesDocsDir)) {
        fs.mkdirSync(modulesDocsDir, { recursive: true });
    }

    if (!fs.existsSync(modulesDir)) {
        console.warn('No modules directory found.');
        return [];
    }

    const moduleEntries = fs.readdirSync(modulesDir).filter(f => 
        fs.statSync(path.join(modulesDir, f)).isDirectory()
    );

    const generatedModules = [];

    for (const modFolder of moduleEntries) {
        const modPath = path.join(modulesDir, modFolder);
        const indexPath = path.join(modPath, 'index.js');
        let modInfo = { name: modFolder, description: 'No description provided.', settings: [] };

        if (fs.existsSync(indexPath)) {
            try {
                const imported = (await import(pathToFileURL(indexPath).href)).default;
                if (imported) {
                    modInfo = {
                        name: imported.name || modFolder,
                        description: imported.description || 'No description provided.',
                        settings: imported.settings || []
                    };
                }
            } catch (err) {
                console.error(`Error loading index.js for ${modFolder}:`, err.message);
            }
        }

        // Commands
        const commands = [];
        const commandsPath = path.join(modPath, 'commands');
        if (fs.existsSync(commandsPath)) {
            const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
            for (const cFile of commandFiles) {
                try {
                    const cmdObj = (await import(pathToFileURL(path.join(commandsPath, cFile)).href)).default;
                    if (cmdObj?.data) {
                        const json = typeof cmdObj.data.toJSON === 'function' ? cmdObj.data.toJSON() : cmdObj.data;
                        commands.push({
                            name: json.name || path.parse(cFile).name,
                            description: json.description || '',
                            options: json.options || [],
                            cooldown: cmdObj.cooldown
                        });
                    }
                } catch (err) {
                    console.error(`Error loading command ${cFile}:`, err.message);
                }
            }
        }

        // Events
        const events = [];
        const eventsPath = path.join(modPath, 'events');
        if (fs.existsSync(eventsPath)) {
            const eventFiles = fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'));
            for (const eFile of eventFiles) {
                try {
                    const evObj = (await import(pathToFileURL(path.join(eventsPath, eFile)).href)).default;
                    if (evObj?.name) {
                        events.push({
                            name: evObj.name,
                            once: Boolean(evObj.once)
                        });
                    }
                } catch (err) {
                    console.error(`Error loading event ${eFile}:`, err.message);
                }
            }
        }

        // Build Markdown Content
        let md = `# ${modInfo.name} Module\n\n`;
        md += `${modInfo.description}\n\n`;

        // Settings Section
        if (modInfo.settings && modInfo.settings.length > 0) {
            md += `## ⚙️ Configuration Settings\n\n`;
            md += `| Key | Description | Type | Default |\n`;
            md += `| :--- | :--- | :--- | :--- |\n`;
            for (const s of modInfo.settings) {
                const def = typeof s.defaultValue === 'object' ? JSON.stringify(s.defaultValue) : String(s.defaultValue);
                md += `| \`${s.key}\` | ${s.description} | \`${s.type}\` | \`${def}\` |\n`;
            }
            md += `\n`;
        }

        // Commands Section
        if (commands.length > 0) {
            md += `## ⌨️ Slash Commands\n\n`;
            for (const cmd of commands) {
                md += `### \`/${cmd.name}\`\n\n`;
                md += `${cmd.description || 'No description available.'}\n\n`;
                if (cmd.cooldown) {
                    md += `- **Cooldown**: ${cmd.cooldown}s\n`;
                }
                if (cmd.options && cmd.options.length > 0) {
                    md += `#### Options\n\n`;
                    for (const opt of cmd.options) {
                        const reqStr = opt.required ? '(Required)' : '(Optional)';
                        md += `- \`${opt.name}\` ${reqStr}: ${opt.description || 'No description'}\n`;
                    }
                    md += `\n`;
                }
            }
        }

        // Events Section
        if (events.length > 0) {
            md += `## 🔔 Registered Events\n\n`;
            for (const ev of events) {
                md += `- **\`${ev.name}\`** (Trigger: \`${ev.once ? 'Once' : 'On'}\`)\n`;
            }
            md += `\n`;
        }

        const outFilePath = path.join(modulesDocsDir, `${modFolder}.md`);
        fs.writeFileSync(outFilePath, md, 'utf-8');
        generatedModules.push({ folder: modFolder, name: modInfo.name, docRelPath: `modules/${modFolder}.md` });
    }

    // Update mkdocs.yml
    if (fs.existsSync(mkdocsPath)) {
        let mkdocsContent = fs.readFileSync(mkdocsPath, 'utf-8');
        
        // Construct the Modules nav list
        const modulesNavLines = [
            '  - Modules:'
        ];
        for (const gm of generatedModules) {
            modulesNavLines.push(`    - ${gm.name}: ${gm.docRelPath}`);
        }
        const modulesNavBlock = modulesNavLines.join('\n');

        if (/  - Modules:(\r?\n {4}- .+)+/.test(mkdocsContent)) {
            mkdocsContent = mkdocsContent.replace(/  - Modules:(\r?\n {4}- .+)+/, modulesNavBlock);
        } else if (mkdocsContent.includes('  - Modules:')) {
            mkdocsContent = mkdocsContent.replace(/  - Modules:[\r\n]*/, modulesNavBlock + '\n');
        } else if (mkdocsContent.includes('nav:')) {
            mkdocsContent = mkdocsContent.replace(/(nav:[\s\S]*?)(?=(\r?\n\S|$))/, `$1\n${modulesNavBlock}`);
        }
        fs.writeFileSync(mkdocsPath, mkdocsContent, 'utf-8');
    }

    return generatedModules;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    generateDocs()
        .then(modules => {
            console.log(`Documentation generated for ${modules.length} modules.`);
        })
        .catch(err => {
            console.error('Failed to generate documentation:', err);
            process.exit(1);
        });
}
