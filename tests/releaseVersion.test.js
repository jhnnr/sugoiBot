import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { evaluateReleaseVersion } from '../scripts/release-version.js';

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
