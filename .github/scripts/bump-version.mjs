// Raises the npm package's version (apps/cli) by patch, minor or major, in its package.json and
// in package-lock.json (its only other copy), and prints the new version. Used by the Release
// workflow: `node .github/scripts/bump-version.mjs patch`.
import fs from 'node:fs';

const bump = process.argv[2];
if (!['patch', 'minor', 'major'].includes(bump)) throw new Error(`Expected patch, minor or major, got "${bump}"`);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

const pkgFile = 'apps/cli/package.json';
const pkg = readJson(pkgFile);
const parts = pkg.version.split('.').map(Number);
if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) throw new Error(`Can't bump version "${pkg.version}"`);
let [major, minor, patch] = parts;
if (bump === 'major') [major, minor, patch] = [major + 1, 0, 0];
if (bump === 'minor') [minor, patch] = [minor + 1, 0];
if (bump === 'patch') patch += 1;
const version = `${major}.${minor}.${patch}`;

// package.json is written by hand (one-line arrays and objects), so only its version line changes.
const pkgText = fs.readFileSync(pkgFile, 'utf8');
const newPkgText = pkgText.replace(`"version": "${pkg.version}"`, `"version": "${version}"`);
if (newPkgText === pkgText) throw new Error(`No "version" line in ${pkgFile}`);
fs.writeFileSync(pkgFile, newPkgText);

const lock = readJson('package-lock.json');
if (!lock.packages?.['apps/cli']) throw new Error('package-lock.json has no apps/cli entry');
lock.packages['apps/cli'].version = version;
writeJson('package-lock.json', lock);

console.log(version);
