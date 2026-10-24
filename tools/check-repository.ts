/** Read-only publication checks. Reports locations and categories, never matching secret values. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });
const files = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean))];
const tracked = new Set(git('ls-files', '-z').toString().split('\0').filter(Boolean));
const problems: { file: string; line?: number; kind: string }[] = [];
let markdown = 0;
let links = 0;
for (const file of files.filter(file => file.endsWith('.md'))) {
  markdown++;
  const content = readFileSync(resolve(root, file), 'utf8').replace(/```[\s\S]*?```|`[^`\n]*`/g, code => code.replace(/[^\n]/g, ' '));
  for (const match of content.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const target = match[1]!.trim().replace(/^<|>$/g, '');
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:|^#/.test(target)) continue;
    links++;
    const path = resolve(root, dirname(file), decodeURIComponent(target.split('#')[0]!));
    const repositoryPath = relative(root, path).split(sep).join('/');
    if (!existsSync(path) || !tracked.has(repositoryPath) && !files.includes(repositoryPath)) {
      problems.push({ file, line: content.slice(0, match.index).split('\n').length, kind: `unpublished-link:${repositoryPath}` });
    }
  }
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; version?: string }>;
};
for (const group of ['dependencies', 'devDependencies'] as const) {
  for (const [name, version] of Object.entries(packageJson[group] ?? {})) {
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) problems.push({ file: 'package.json', kind: `unpinned:${name}` });
    if (version !== lock.packages['']?.[group]?.[name] || version !== lock.packages[`node_modules/${name}`]?.version) {
      problems.push({ file: 'package-lock.json', kind: `version-mismatch:${name}` });
    }
  }
}

const objects = new Map(git('rev-list', '--objects', '--all').toString().trim().split('\n').map((line): [string, string] => {
  const at = line.indexOf(' ');
  return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)];
}));
for (const path of new Set(objects.values())) {
  if (/(?:^|\/)\.env(?:\.|$)/.test(path) && !/(?:^|\/)\.env\.example$/.test(path)
    || /^reference\/game\//.test(path) || /\.(?:dll|pdb|xnb|sqlite|db)$/.test(path)) {
    problems.push({ file: path, kind: 'private-or-binary-history' });
  }
}
// Query exactly the reachable objects; batch-check with no stdin would inspect no objects.
const kinds = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
  cwd: root, input: [...objects.keys()].join('\n') + '\n', maxBuffer: 32 * 1024 * 1024,
}).toString().trim().split('\n');
const blobs = kinds.filter(line => line.split(' ')[1] === 'blob').map(line => line.split(' ')[0]!);
const bytes = execFileSync('git', ['cat-file', '--batch'], {
  cwd: root, input: blobs.join('\n') + '\n', maxBuffer: 256 * 1024 * 1024,
});
const patterns = [
  ['api-key', /\bsk-[a-zA-Z0-9_-]{20,}/g],
  ['github-token', /\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{40,})/g],
  ['aws-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
] as const;
const envPath = resolve(root, '.env');
const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
const localSecrets: [string, string][] = [];
for (const [name, value] of Object.entries(env)) {
  if (typeof value === 'string' && /KEY|TOKEN|SECRET|PASSWORD/.test(name) && value.length >= 10) localSecrets.push([name, value]);
}
let offset = 0;
for (const sha of blobs) {
  const newline = bytes.indexOf(10, offset);
  const size = Number(bytes.subarray(offset, newline).toString().split(' ')[2]);
  const content = bytes.subarray(newline + 1, newline + 1 + size).toString('utf8');
  offset = newline + 1 + size + 1;
  for (const [kind, pattern] of patterns) {
    for (const match of content.matchAll(pattern)) problems.push({ file: objects.get(sha) || sha,
      line: content.slice(0, match.index).split('\n').length, kind });
  }
  for (const [name, value] of localSecrets) {
    if (content.includes(value)) problems.push({ file: objects.get(sha) || sha, kind: `local-env-secret:${name}` });
  }
}
for (const file of files) {
  const content = readFileSync(resolve(root, file), 'utf8');
  for (const [kind, pattern] of patterns) {
    for (const match of content.matchAll(pattern)) problems.push({ file,
      line: content.slice(0, match.index).split('\n').length, kind });
  }
  for (const [name, value] of localSecrets) {
    if (content.includes(value)) problems.push({ file, kind: `local-env-secret:${name}` });
  }
}
console.log(JSON.stringify({ files: files.length, markdown, links, reachableBlobs: blobs.length, problems }, null, 2));
process.exitCode = problems.length ? 1 : 0;
