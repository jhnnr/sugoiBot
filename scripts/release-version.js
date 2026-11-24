import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEV_VERSION_REGEX = /^v?\d+\.\d+\.\d+-dev(?:\.\d+)?$/;
const STABLE_VERSION_REGEX = /^v?\d+\.\d+\.\d+$/;
const ZERO_SHA = '0000000000000000000000000000000000000000';

/**
 * Evaluates package.json version and git state to determine CI release actions.
 *
 * @param {object} options
 * @param {string} options.version
 * @param {string} [options.prevVersion='']
 * @param {string[]|Set<string>} [options.existingTags=[]]
 * @param {string} [options.eventName='push']
 */
export function evaluateReleaseVersion({
    version,
    prevVersion = '',
    existingTags = [],
    eventName = 'push'
} = {}) {
    const trimmedVersion = typeof version === 'string' ? version.trim() : '';
    const isDev = DEV_VERSION_REGEX.test(trimmedVersion);
    const isStable = !isDev && STABLE_VERSION_REGEX.test(trimmedVersion);

    if (!isDev && !isStable) {
        throw new Error(
            `Invalid package.json version "${trimmedVersion}". Expected vX.Y.Z, vX.Y.Z-dev, or vX.Y.Z-dev.N (leading "v" optional).`
        );
    }

    const releaseType = isDev ? 'dev' : 'stable';
    const cleanVersion = trimmedVersion.replace(/^v/, '');
    const dockerTag = trimmedVersion;
    const includeLatest = isStable;
    const createGithubRelease = isStable;
    const githubReleaseTag = isStable ? `v${cleanVersion}` : '';

    const normalizedPrev = typeof prevVersion === 'string' ? prevVersion.trim() : '';
    const tagList = Array.isArray(existingTags) || existingTags instanceof Set
        ? Array.from(existingTags, tag => String(tag).trim()).filter(Boolean)
        : [];
    const tagSet = new Set(tagList);

    let changed = false;
    let reason = '';

    if (isStable && (tagSet.has(`v${cleanVersion}`) || tagSet.has(cleanVersion))) {
        changed = false;
        reason = `Tag v${cleanVersion} already exists. Skipping build and push.`;
    } else if (eventName === 'workflow_dispatch') {
        changed = true;
        reason = `Manual workflow_dispatch trigger for ${releaseType} version ${trimmedVersion}. Proceeding with build and push.`;
    } else if (!normalizedPrev) {
        changed = true;
        reason = `No previous commit version found; treating ${releaseType} version ${trimmedVersion} as changed.`;
    } else if (trimmedVersion !== normalizedPrev) {
        changed = true;
        reason = `Version changed from '${normalizedPrev}' to '${trimmedVersion}' (${releaseType}).`;
    } else {
        changed = false;
        reason = `Version has not changed (${trimmedVersion}). Skipping build and push.`;
    }

    return {
        changed,
        version: trimmedVersion,
        releaseType,
        isDev,
        isStable,
        dockerTag,
        includeLatest,
        createGithubRelease,
        githubReleaseTag,
        reason
    };
}

function readPackageVersionAtRef(ref, cwd) {
    try {
        execFileSync('git', ['cat-file', '-e', `${ref}:package.json`], {
            cwd,
            stdio: 'ignore'
        });
        const raw = execFileSync('git', ['show', `${ref}:package.json`], {
            cwd,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const parsed = JSON.parse(raw);
        return typeof parsed.version === 'string' ? parsed.version.trim() : '';
    } catch {
        return null;
    }
}

function resolvePreviousVersion(cwd) {
    const beforeSha = (process.env.GITHUB_EVENT_BEFORE || '').trim();
    if (beforeSha && beforeSha !== ZERO_SHA && /^[0-9a-f]{40}$/i.test(beforeSha)) {
        const fromBefore = readPackageVersionAtRef(beforeSha, cwd);
        if (fromBefore !== null) {
            return fromBefore;
        }
    }

    const fromHeadParent = readPackageVersionAtRef('HEAD~1', cwd);
    return fromHeadParent !== null ? fromHeadParent : '';
}

function getExistingGitTags(cwd) {
    try {
        const output = execFileSync('git', ['tag', '--list'], {
            cwd,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        return output
            .split(/\r?\n/)
            .map(tag => tag.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

function runCli() {
    const rootDir = path.resolve(__dirname, '..');
    const pkgPath = path.join(rootDir, 'package.json');

    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const prevVersion = resolvePreviousVersion(rootDir);
        const existingTags = getExistingGitTags(rootDir);
        const eventName = (process.env.GITHUB_EVENT_NAME || 'push').trim() || 'push';

        const result = evaluateReleaseVersion({
            version: pkg.version,
            prevVersion,
            existingTags,
            eventName
        });

        console.log(result.reason);

        if (process.env.GITHUB_OUTPUT) {
            const lines = [
                `changed=${result.changed}`,
                `version=${result.version}`,
                `release_type=${result.releaseType}`,
                `is_dev=${result.isDev}`,
                `is_stable=${result.isStable}`,
                `docker_tag=${result.dockerTag}`,
                `include_latest=${result.includeLatest}`,
                `create_github_release=${result.createGithubRelease}`,
                `github_release_tag=${result.githubReleaseTag}`
            ];
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf-8');
        }
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    runCli();
}
