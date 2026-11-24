import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { evaluateReleaseVersion, extractChangelogSection } from '../scripts/release-version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('evaluateReleaseVersion', () => {
    describe('initial dev builds', () => {
        it('evaluates v1.2.0-dev with exact dockerTag and no GitHub release or latest tag', () => {
            const result = evaluateReleaseVersion({
                version: 'v1.2.0-dev',
                prevVersion: 'v1.1.0',
                existingTags: ['v1.1.0']
            });

            expect(result).toMatchObject({
                changed: true,
                version: 'v1.2.0-dev',
                releaseType: 'dev',
                isDev: true,
                isStable: false,
                dockerTag: 'v1.2.0-dev',
                includeLatest: false,
                createGithubRelease: false,
                githubReleaseTag: ''
            });
        });

        it('evaluates 1.2.0-dev (without leading v) preserving exact dockerTag when bumped from 1.2.0 or 1.1.0', () => {
            const fromPriorMinor = evaluateReleaseVersion({
                version: '1.2.0-dev',
                prevVersion: '1.1.0'
            });
            expect(fromPriorMinor).toMatchObject({
                changed: true,
                version: '1.2.0-dev',
                releaseType: 'dev',
                isDev: true,
                isStable: false,
                dockerTag: '1.2.0-dev',
                includeLatest: false,
                createGithubRelease: false,
                githubReleaseTag: ''
            });

            const fromSameBaseStable = evaluateReleaseVersion({
                version: '1.2.0-dev',
                prevVersion: '1.2.0'
            });
            expect(fromSameBaseStable.changed).toBe(true);
            expect(fromSameBaseStable.dockerTag).toBe('1.2.0-dev');
            expect(fromSameBaseStable.createGithubRelease).toBe(false);
            expect(fromSameBaseStable.includeLatest).toBe(false);
        });

        it('treats initial commit without prevVersion as changed', () => {
            const result = evaluateReleaseVersion({
                version: 'v1.2.0-dev',
                prevVersion: ''
            });
            expect(result.changed).toBe(true);
            expect(result.releaseType).toBe('dev');
        });
    });

    describe('subsequent numbered dev builds', () => {
        it('marks incremented dev versions as changed across v-prefixed and plain versions', () => {
            const dev1 = evaluateReleaseVersion({
                version: 'v1.2.0-dev.1',
                prevVersion: 'v1.2.0-dev'
            });
            expect(dev1).toMatchObject({
                changed: true,
                releaseType: 'dev',
                isDev: true,
                isStable: false,
                dockerTag: 'v1.2.0-dev.1',
                includeLatest: false,
                createGithubRelease: false,
                githubReleaseTag: ''
            });

            const dev2 = evaluateReleaseVersion({
                version: 'v1.2.0-dev.2',
                prevVersion: 'v1.2.0-dev.1'
            });
            expect(dev2).toMatchObject({
                changed: true,
                releaseType: 'dev',
                dockerTag: 'v1.2.0-dev.2',
                includeLatest: false,
                createGithubRelease: false,
                githubReleaseTag: ''
            });

            const plainDev1 = evaluateReleaseVersion({
                version: '1.2.0-dev.1',
                prevVersion: '1.2.0-dev'
            });
            expect(plainDev1).toMatchObject({
                changed: true,
                releaseType: 'dev',
                dockerTag: '1.2.0-dev.1',
                includeLatest: false,
                createGithubRelease: false,
                githubReleaseTag: ''
            });

            const multiDigitDev = evaluateReleaseVersion({
                version: '1.2.0-dev.12',
                prevVersion: '1.2.0-dev.11'
            });
            expect(multiDigitDev).toMatchObject({
                changed: true,
                releaseType: 'dev',
                dockerTag: '1.2.0-dev.12',
                includeLatest: false,
                createGithubRelease: false,
                githubReleaseTag: ''
            });
        });

        it('marks unchanged dev versions as changed === false on push', () => {
            const unchangedV = evaluateReleaseVersion({
                version: 'v1.2.0-dev.1',
                prevVersion: 'v1.2.0-dev.1',
                eventName: 'push'
            });
            expect(unchangedV.changed).toBe(false);
            expect(unchangedV.createGithubRelease).toBe(false);
            expect(unchangedV.includeLatest).toBe(false);

            const unchangedPlain = evaluateReleaseVersion({
                version: '1.2.0-dev.12',
                prevVersion: '1.2.0-dev.12',
                eventName: 'push'
            });
            expect(unchangedPlain.changed).toBe(false);
        });

        it('ignores existingTags for dev builds even if matching tags are passed', () => {
            const result = evaluateReleaseVersion({
                version: 'v1.2.0-dev.1',
                prevVersion: 'v1.2.0-dev',
                existingTags: ['v1.2.0-dev.1', '1.2.0-dev.1', 'v1.2.0']
            });

            expect(result.changed).toBe(true);
            expect(result.createGithubRelease).toBe(false);
            expect(result.githubReleaseTag).toBe('');
            expect(result.includeLatest).toBe(false);
        });
    });

    describe('stable releases', () => {
        it('evaluates v1.2.0 with normalized v1.2.0 GitHub release tag (never vv1.2.0) and latest enabled', () => {
            const result = evaluateReleaseVersion({
                version: 'v1.2.0',
                prevVersion: 'v1.2.0-dev.2',
                existingTags: ['v1.1.0']
            });

            expect(result).toMatchObject({
                changed: true,
                version: 'v1.2.0',
                releaseType: 'stable',
                isDev: false,
                isStable: true,
                dockerTag: 'v1.2.0',
                includeLatest: true,
                createGithubRelease: true,
                githubReleaseTag: 'v1.2.0'
            });
        });

        it('evaluates 1.2.0 (without leading v) preserving exact dockerTag while tagging GitHub release as v1.2.0', () => {
            const result = evaluateReleaseVersion({
                version: '1.2.0',
                prevVersion: '1.2.0-dev.2',
                existingTags: ['v1.1.0']
            });

            expect(result).toMatchObject({
                changed: true,
                version: '1.2.0',
                releaseType: 'stable',
                isDev: false,
                isStable: true,
                dockerTag: '1.2.0',
                includeLatest: true,
                createGithubRelease: true,
                githubReleaseTag: 'v1.2.0'
            });
        });

        it('skips stable build when v1.2.0 or 1.2.0 already exists in existingTags', () => {
            const withPrefixedTag = evaluateReleaseVersion({
                version: '1.2.0',
                prevVersion: '1.2.0-dev.2',
                existingTags: ['v1.1.0', 'v1.2.0']
            });
            expect(withPrefixedTag.changed).toBe(false);
            expect(withPrefixedTag.reason).toContain('Tag v1.2.0 already exists');

            const withPlainTag = evaluateReleaseVersion({
                version: 'v1.2.0',
                prevVersion: 'v1.2.0-dev.2',
                existingTags: new Set(['1.2.0'])
            });
            expect(withPlainTag.changed).toBe(false);
            expect(withPlainTag.reason).toContain('Tag v1.2.0 already exists');
        });

        it('skips stable build on push when version did not change from prevVersion', () => {
            const result = evaluateReleaseVersion({
                version: '1.2.0',
                prevVersion: '1.2.0',
                existingTags: [],
                eventName: 'push'
            });
            expect(result.changed).toBe(false);
        });

        it('trims surrounding whitespace on version and prevVersion', () => {
            const result = evaluateReleaseVersion({
                version: '  1.2.0  ',
                prevVersion: '  1.2.0-dev.1  ',
                existingTags: []
            });
            expect(result.changed).toBe(true);
            expect(result.version).toBe('1.2.0');
            expect(result.dockerTag).toBe('1.2.0');
            expect(result.githubReleaseTag).toBe('v1.2.0');
        });
    });

    describe('workflow_dispatch behavior', () => {
        it('publishes dev build even when prevVersion equals version', () => {
            const result = evaluateReleaseVersion({
                version: 'v1.2.0-dev.1',
                prevVersion: 'v1.2.0-dev.1',
                existingTags: ['v1.2.0-dev.1'],
                eventName: 'workflow_dispatch'
            });

            expect(result.changed).toBe(true);
            expect(result.releaseType).toBe('dev');
            expect(result.createGithubRelease).toBe(false);
            expect(result.includeLatest).toBe(false);
        });

        it('publishes stable build when prevVersion equals version and tag does not yet exist', () => {
            const result = evaluateReleaseVersion({
                version: '1.2.0',
                prevVersion: '1.2.0',
                existingTags: ['v1.1.0'],
                eventName: 'workflow_dispatch'
            });

            expect(result.changed).toBe(true);
            expect(result.releaseType).toBe('stable');
            expect(result.createGithubRelease).toBe(true);
            expect(result.githubReleaseTag).toBe('v1.2.0');
            expect(result.includeLatest).toBe(true);
        });

        it('still skips stable build on workflow_dispatch when git tag already exists', () => {
            const result = evaluateReleaseVersion({
                version: 'v1.2.0',
                prevVersion: 'v1.2.0-dev.2',
                existingTags: ['v1.2.0'],
                eventName: 'workflow_dispatch'
            });

            expect(result.changed).toBe(false);
            expect(result.reason).toContain('Tag v1.2.0 already exists');
        });
    });

    describe('invalid version formats', () => {
        it.each([
            [''],
            ['   '],
            ['1.2'],
            ['1.2.0-alpha'],
            ['1.2.0-dev.'],
            ['1.2.0-dev.abc'],
            ['v1.2.0.4']
        ])('throws an Error for invalid version %j', (invalidVersion) => {
            expect(() => evaluateReleaseVersion({ version: invalidVersion })).toThrow(/Invalid package\.json version/);
        });

        it('throws an Error when called without options or version', () => {
            expect(() => evaluateReleaseVersion()).toThrow(/Invalid package\.json version/);
            expect(() => evaluateReleaseVersion({})).toThrow(/Invalid package\.json version/);
        });
    });

    describe('CLI entrypoint GITHUB_OUTPUT integration', () => {
        it('writes all expected key=value outputs when GITHUB_OUTPUT is set', () => {
            const tmpFile = path.join(os.tmpdir(), `sugoibot-gh-output-${process.pid}-${Date.now()}.txt`);
            const scriptPath = path.resolve(__dirname, '..', 'scripts', 'release-version.js');

            try {
                execFileSync(process.execPath, [scriptPath], {
                    env: {
                        ...process.env,
                        GITHUB_OUTPUT: tmpFile,
                        GITHUB_EVENT_NAME: 'push'
                    },
                    encoding: 'utf-8'
                });

                const content = fs.readFileSync(tmpFile, 'utf-8').trim();
                const keys = content.split(/\r?\n/).map(line => line.split('=')[0]);

                expect(keys).toEqual([
                    'changed',
                    'version',
                    'release_type',
                    'is_dev',
                    'is_stable',
                    'docker_tag',
                    'include_latest',
                    'create_github_release',
                    'github_release_tag'
                ]);
            } finally {
                if (fs.existsSync(tmpFile)) {
                    fs.unlinkSync(tmpFile);
                }
            }
        });
    });
});

describe('extractChangelogSection', () => {
    describe('heading format variations', () => {
        it.each([
            ['## [v1.3.3] - 2026-11-24'],
            ['## [1.3.3] - 2026-11-24'],
            ['## v1.3.3'],
            ['## 1.3.3']
        ])('extracts matching section for %j whether version is "1.3.3" or "v1.3.3"', (heading) => {
            const changelog = [
                '# Changelog',
                '',
                '## [Unreleased]',
                '### Added',
                '- Upcoming change',
                '',
                heading,
                '### Fixed',
                '- Resolved audit mention formatting',
                '',
                '## [v1.3.2] - 2026-11-18',
                '### Fixed',
                '- Older fix'
            ].join('\n');

            expect(extractChangelogSection(changelog, '1.3.3')).toBe(
                '### Fixed\n- Resolved audit mention formatting'
            );
            expect(extractChangelogSection(changelog, 'v1.3.3')).toBe(
                '### Fixed\n- Resolved audit mention formatting'
            );
            expect(extractChangelogSection(changelog, '  v1.3.3  ')).toBe(
                '### Fixed\n- Resolved audit mention formatting'
            );
        });
    });

    describe('Markdown preservation and boundary stripping', () => {
        const expectedV133Body = [
            '### Added',
            '- Added `--extract-notes` support writing to `$RUNNER_TEMP/release-notes.md` and `$GITHUB_OUTPUT`.',
            '- Preserves `$variables`, `${GITHUB_SHA}`, `$1`, `$&`, and `` `inline code` `` verbatim.',
            '',
            '```bash',
            '## Comment inside fenced code block must not end the section',
            'node scripts/release-version.js --extract-notes "$RUNNER_TEMP/release-notes.md"',
            '```',
            '',
            '### Fixed',
            '- Resolved `<@id>` and `**bold**` formatting in `loggingService`.'
        ].join('\n');

        const sampleChangelog = [
            '# Changelog',
            '',
            '## [Unreleased]',
            '',
            '### Added',
            '- Draft feature in Unreleased',
            '',
            '---',
            '',
            '## [v1.3.3] - 2026-11-24',
            '',
            expectedV133Body,
            '',
            '---',
            '',
            '## [v1.3.2] - 2026-11-18',
            '',
            '### Fixed',
            '- Prevented false-positive `#floatingSaveBar` prompts.',
            '',
            '[Unreleased]: https://github.com/jhnnr/sugoiBot/compare/v1.3.3...HEAD',
            '[v1.3.3]: https://github.com/jhnnr/sugoiBot/compare/v1.3.2...v1.3.3',
            '[v1.3.2]: https://github.com/jhnnr/sugoiBot/compare/v1.3.1...v1.3.2'
        ].join('\n');

        it('preserves subheadings, bullets, code blocks, $variables, and backticks while excluding Unreleased, older versions, --- dividers, and link definitions', () => {
            const extracted = extractChangelogSection(sampleChangelog, '1.3.3');

            expect(extracted).toBe(expectedV133Body);
            expect(extracted).not.toContain('Unreleased');
            expect(extracted).not.toContain('v1.3.2');
            expect(extracted).not.toContain('#floatingSaveBar');
            expect(extracted).not.toMatch(/^---$/m);
            expect(extracted).not.toContain('[v1.3.3]:');
        });

        it('strips trailing reference-link definitions at EOF when extracting the oldest version section', () => {
            const extractedOldest = extractChangelogSection(sampleChangelog, 'v1.3.2');

            expect(extractedOldest).toBe(
                '### Fixed\n- Prevented false-positive `#floatingSaveBar` prompts.'
            );
            expect(extractedOldest).not.toContain('[Unreleased]:');
            expect(extractedOldest).not.toContain('[v1.3.3]:');
            expect(extractedOldest).not.toContain('[v1.3.2]:');
        });
    });

    describe('line endings', () => {
        it('handles both LF (\\n) and CRLF (\\r\\n) line endings identically', () => {
            const lfChangelog = [
                '# Changelog',
                '',
                '## [Unreleased]',
                '- Unreleased item',
                '',
                '## [v1.3.3] - 2026-11-24',
                '',
                '### Added',
                '- Multi-line item one',
                '- Multi-line item two with `$ENV_VAR` and `code`',
                '',
                '---',
                '',
                '## [v1.3.2] - 2026-11-18',
                '- Prior item',
                '',
                '[v1.3.3]: https://github.com/jhnnr/sugoiBot/compare/v1.3.2...v1.3.3'
            ].join('\n');
            const crlfChangelog = lfChangelog.replace(/\n/g, '\r\n');

            const fromLf = extractChangelogSection(lfChangelog, '1.3.3');
            const fromCrlf = extractChangelogSection(crlfChangelog, 'v1.3.3');

            expect(fromCrlf).toBe(fromLf);
            expect(fromCrlf).not.toContain('\r');
            expect(fromCrlf).toBe(
                '### Added\n- Multi-line item one\n- Multi-line item two with `$ENV_VAR` and `code`'
            );
        });
    });

    describe('missing, empty, and prefix-collision safety', () => {
        it('returns empty string when version does not exist or inputs are empty', () => {
            const changelog = '## [v1.3.3] - 2026-11-24\n### Fixed\n- Bug fix\n';

            expect(extractChangelogSection(changelog, '9.9.9')).toBe('');
            expect(extractChangelogSection(changelog, 'v9.9.9')).toBe('');
            expect(extractChangelogSection(changelog, '')).toBe('');
            expect(extractChangelogSection(changelog, 'v')).toBe('');
            expect(extractChangelogSection(changelog, '   ')).toBe('');
            expect(extractChangelogSection('', '1.3.3')).toBe('');
            expect(extractChangelogSection(null, '1.3.3')).toBe('');
            expect(extractChangelogSection(changelog, null)).toBe('');
        });

        it('returns empty string when matching section has an empty body', () => {
            const emptyBetweenSections = [
                '## [v1.3.4] - 2026-11-25',
                '',
                '---',
                '',
                '## [v1.3.3] - 2026-11-24',
                '### Fixed',
                '- Real content',
                '',
                '## [v1.3.2] - 2026-11-18',
                '',
                '[v1.3.2]: https://github.com/jhnnr/sugoiBot/releases/tag/v1.3.2'
            ].join('\n');

            expect(extractChangelogSection(emptyBetweenSections, '1.3.4')).toBe('');
            expect(extractChangelogSection(emptyBetweenSections, 'v1.3.2')).toBe('');
        });

        it('does NOT falsely match 1.3.0 against 1.3.0-dev or 1.3.0-dev.N headings', () => {
            const devHeadingsChangelog = [
                '## [v1.3.0-dev.1] - 2026-11-24',
                '- Numbered dev prerelease item',
                '',
                '## [1.3.0-dev] - 2026-11-23',
                '- Bracketed dev item',
                '',
                '## v1.3.0-dev',
                '- Unbracketed v-prefixed dev item',
                '',
                '## 1.3.0-dev',
                '- Unbracketed plain dev item'
            ].join('\n');

            expect(extractChangelogSection(devHeadingsChangelog, '1.3.0')).toBe('');
            expect(extractChangelogSection(devHeadingsChangelog, 'v1.3.0')).toBe('');
        });

        it('does NOT falsely match 1.3.1 against 1.3.10 or 1.3.10 against 1.3.1 (or unescaped dot wildcards)', () => {
            const onlyV1310 = [
                '## [v1.3.10] - 2026-11-24',
                '- Ten patch release',
                '',
                '## [1.3.10] - 2026-11-24',
                '- Ten bracketed plain',
                '',
                '## v1.3.10',
                '- Ten unbracketed v',
                '',
                '## 1.3.10',
                '- Ten unbracketed plain',
                '',
                '## [v1X3Y1] - 2026-11-24',
                '- Wildcard dot trap'
            ].join('\n');

            expect(extractChangelogSection(onlyV1310, '1.3.1')).toBe('');
            expect(extractChangelogSection(onlyV1310, 'v1.3.1')).toBe('');

            const onlyV131 = [
                '## [v1.3.1] - 2026-11-18',
                '- One patch release',
                '',
                '## 1.3.1',
                '- One unbracketed'
            ].join('\n');

            expect(extractChangelogSection(onlyV131, '1.3.10')).toBe('');
            expect(extractChangelogSection(onlyV131, 'v1.3.10')).toBe('');
        });
    });
});

describe('CLI --extract-notes integration', () => {
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'release-version.js');

    it('writes extracted section to temp file and sets has_release_notes=true in GITHUB_OUTPUT when found', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sugoibot-extract-found-'));
        const changelogFile = path.join(tmpDir, 'CHANGELOG.md');
        const notesFile = path.join(tmpDir, 'release-notes.md');
        const ghOutputFile = path.join(tmpDir, 'github-output.txt');

        try {
            fs.writeFileSync(
                changelogFile,
                [
                    '# Changelog',
                    '',
                    '## [Unreleased]',
                    '- Next release work',
                    '',
                    '## [v1.3.3] - 2026-11-24',
                    '',
                    '### Fixed',
                    '- Preserved `$RUNNER_TEMP` and `` `code` `` in notes.',
                    '',
                    '## [v1.3.2] - 2026-11-18',
                    '- Older fix',
                    '',
                    '[v1.3.3]: https://github.com/jhnnr/sugoiBot/compare/v1.3.2...v1.3.3'
                ].join('\n'),
                'utf-8'
            );

            execFileSync(
                process.execPath,
                [
                    scriptPath,
                    '--extract-notes',
                    notesFile,
                    '--version',
                    'v1.3.3',
                    '--changelog',
                    changelogFile
                ],
                {
                    env: {
                        ...process.env,
                        GITHUB_OUTPUT: ghOutputFile
                    },
                    encoding: 'utf-8'
                }
            );

            expect(fs.existsSync(notesFile)).toBe(true);
            expect(fs.readFileSync(notesFile, 'utf-8')).toBe(
                '### Fixed\n- Preserved `$RUNNER_TEMP` and `` `code` `` in notes.\n'
            );

            const ghOutput = fs.readFileSync(ghOutputFile, 'utf-8').trim().split(/\r?\n/);
            expect(ghOutput).toEqual([
                'has_release_notes=true',
                `notes_file=${notesFile}`
            ]);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('sets has_release_notes=false in GITHUB_OUTPUT and removes stale output file when version is missing or CHANGELOG is absent', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sugoibot-extract-missing-'));
        const changelogFile = path.join(tmpDir, 'CHANGELOG.md');
        const notesFile = path.join(tmpDir, 'release-notes.md');
        const ghOutputFile = path.join(tmpDir, 'github-output.txt');

        try {
            fs.writeFileSync(changelogFile, '# Changelog\n\n## [v1.3.2] - 2026-11-18\n- Existing note\n', 'utf-8');
            fs.writeFileSync(notesFile, 'stale pre-existing content', 'utf-8');

            execFileSync(
                process.execPath,
                [
                    scriptPath,
                    `--extract-notes=${notesFile}`,
                    '--version=1.9.0',
                    `--changelog=${changelogFile}`
                ],
                {
                    env: {
                        ...process.env,
                        GITHUB_OUTPUT: ghOutputFile
                    },
                    encoding: 'utf-8'
                }
            );

            expect(fs.existsSync(notesFile)).toBe(false);
            expect(fs.readFileSync(ghOutputFile, 'utf-8').trim().split(/\r?\n/)).toEqual([
                'has_release_notes=false',
                `notes_file=${notesFile}`
            ]);

            const ghOutputMissingFile = path.join(tmpDir, 'github-output-absent.txt');
            execFileSync(
                process.execPath,
                [
                    scriptPath,
                    '--extract-notes',
                    notesFile,
                    '--version',
                    '1.3.3',
                    '--changelog',
                    path.join(tmpDir, 'DOES_NOT_EXIST.md')
                ],
                {
                    env: {
                        ...process.env,
                        GITHUB_OUTPUT: ghOutputMissingFile
                    },
                    encoding: 'utf-8'
                }
            );

            expect(fs.existsSync(notesFile)).toBe(false);
            expect(fs.readFileSync(ghOutputMissingFile, 'utf-8').trim().split(/\r?\n/)).toEqual([
                'has_release_notes=false',
                `notes_file=${notesFile}`
            ]);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('live repository CHANGELOG.md integration', () => {
    it('validates current package.json version and extracts stable sections (1.3.3 & 1.0.0) from real CHANGELOG.md', () => {
        const rootDir = path.resolve(__dirname, '..');
        const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
        const changelogContent = fs.readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf-8');

        const evalResult = evaluateReleaseVersion({ version: pkg.version });
        expect(evalResult.version).toBe(pkg.version);
        expect(evalResult.isDev !== evalResult.isStable).toBe(true);

        expect(changelogContent).not.toContain('## [Unreleased]');
        expect(changelogContent).not.toContain('[Unreleased]:');
        expect(changelogContent).toContain('https://github.com/jhnnr/sugoiBot/compare/');

        const sectionPlain = extractChangelogSection(changelogContent, '1.3.3');
        const sectionPrefixed = extractChangelogSection(changelogContent, 'v1.3.3');
        const oldestSection = extractChangelogSection(changelogContent, '1.0.0');

        expect(sectionPlain.length).toBeGreaterThan(0);
        expect(sectionPrefixed).toBe(sectionPlain);
        expect(sectionPlain).toMatch(/^###\s+/m);
        expect(sectionPlain).not.toContain('## [v1.3.2]');
        expect(sectionPlain).not.toContain('[v1.3.3]:');

        expect(oldestSection.length).toBeGreaterThan(0);
        expect(oldestSection).not.toContain('[v1.0.0]:');
        expect(oldestSection).not.toContain('[v1.3.3]:');

        if (evalResult.isStable) {
            expect(extractChangelogSection(changelogContent, pkg.version).length).toBeGreaterThan(0);
        } else {
            expect(extractChangelogSection(changelogContent, pkg.version)).toBe('');
        }

        const cliTargetVersion = evalResult.isStable ? pkg.version : '1.3.3';
        const expectedNotes = extractChangelogSection(changelogContent, cliTargetVersion);

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sugoibot-live-changelog-'));
        const notesFile = path.join(tmpDir, 'release-notes.md');
        const ghOutputFile = path.join(tmpDir, 'github-output.txt');
        const scriptPath = path.join(rootDir, 'scripts', 'release-version.js');

        try {
            execFileSync(process.execPath, [scriptPath, '--extract-notes', notesFile, '--version', cliTargetVersion], {
                env: {
                    ...process.env,
                    GITHUB_OUTPUT: ghOutputFile
                },
                encoding: 'utf-8'
            });

            expect(fs.readFileSync(notesFile, 'utf-8')).toBe(`${expectedNotes}\n`);
            expect(fs.readFileSync(ghOutputFile, 'utf-8').trim().split(/\r?\n/)).toEqual([
                'has_release_notes=true',
                `notes_file=${notesFile}`
            ]);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
