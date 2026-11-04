import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { readPassphrase } from './release-key-file.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = `v${pkg.version}`;

console.log('========================================================');
console.log(`        AIVIN CLI - PHAT HANH PHIEN BAN ${version}`);
console.log('========================================================\n');

try {
  // Buoc 1: Kiem tra ban build trong dist
  console.log(`[1/4] Kiem tra ban build cho ${version}...`);
  const sumsFile = path.join(root, 'dist', 'SHA256SUMS');
  if (!fs.existsSync(sumsFile)) {
    console.log(`Chua co ban build trong dist/ - dang tai tu GitHub Release ${version}...`);
    execSync(`node scripts/release-fetch.mjs ${version}`, { stdio: 'inherit' });
  } else {
    console.log('Ban build da co san trong dist/.');
  }

  // Buoc 2: Ky ban phat hanh
  console.log('\n[2/4] Ky ban phat hanh...');
  // Chay script ky voi terminal tuong tac
  execSync('node scripts/sign-release.mjs', { stdio: 'inherit' });

  // Buoc 3: Publish len site get.aivin.vn
  console.log('\n[3/4] Dang ban phat hanh len get.aivin.vn...');
  execSync('node scripts/publish-get.mjs', { stdio: 'inherit' });

  // Buoc 4: Publish len npm
  console.log('\n[4/4] Xuat ban goi len npm...');
  try {
    execSync('npm publish', { stdio: 'inherit' });
    console.log(`\n Da xuat ban @aivin-labs/cli@${pkg.version} len npm thanh cong!`);
  } catch (npmErr) {
    console.warn('\n[CANH BAO] Xuat ban npm chua thanh cong.');
    console.warn('Neu chua dang nhap npm hoac het phien, hay mo terminal go: npm login');
  }

  console.log('\n========================================================');
  console.log(`  HOAN TAT PHAT HANH PHIEN BAN ${version}!`);
  console.log('========================================================');
} catch (err) {
  console.error('\n[LOI]', err.message || err);
  process.exitCode = 1;
}
