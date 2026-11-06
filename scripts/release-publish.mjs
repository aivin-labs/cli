import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { RELEASE_PUBLIC_KEYS } from '../bin/lib/releaseKeys.mjs';
import { verifyReleaseSignature } from '../bin/lib/selfUpdate.mjs';
import { runTool, waitForCiBuild } from './release-ci.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const readPkg = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let pkg = readPkg();
let version = `v${pkg.version}`;
const REPO = process.env.AIVIN_CLI_REPO || 'aivin-labs/cli';
const RELEASE_BRANCH = 'main';
const SHIPPED = ['bin', 'docs', 'README.md', 'package.json', 'LICENSE'];
// Tests are part of the source snapshot behind each release tag, even though npm does not ship them.
// A test-only fix must get a new tag so CI does not keep reusing the failing run for an older tag.
const RELEASE_INPUTS = [...SHIPPED, 'test'];
const dist = path.join(root, 'dist');
const site = path.join(root, 'deploy', 'get', 'site');
// Khong qua shell: cmd.exe nuot ky tu ^ trong `tag^{commit}` (tag co that van bi bao "chua co tag").
const git = (...args) => runTool('git', args);
const gh = (...args) => runTool('gh', args);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const hasTag = (tag) => { try { git('rev-parse', '--verify', `${tag}^{commit}`); return true; } catch { return false; } };

/** Tu dong chi tren nhanh phat hanh, da theo kip origin: khong bao gio tao ban tu nhanh khac / code chua ai thay. */
function assertCanRelease() {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== RELEASE_BRANCH) throw new Error(`Dang o nhanh ${branch} - chi tu tao phien ban moi tren ${RELEASE_BRANCH}.`);
  git('fetch', 'origin', RELEASE_BRANCH);
  if (git('rev-list', '--count', `HEAD..origin/${RELEASE_BRANCH}`) !== '0') throw new Error(`${RELEASE_BRANCH} dang sau origin - chay \`git pull --rebase\` roi chay lai.`);
}

/**
 * Buoc 0: ma nguon phai trung tag cua phien ban (ban npm build tu thu muc nay, ban tai ve do CI build tu tag). Chua trung thi tu lam:
 * - code moi hon tag -> tang patch, commit dung 2 tep phien ban, tao tag, day len;
 * - da tang phien ban nhung chua co tag -> tao tag tai HEAD, day len;
 * - co tag nhung chua len origin -> day tag.
 */
function ensureTaggedRelease() {
  if (git('status', '--porcelain', '--', ...RELEASE_INPUTS)) throw new Error('Tep dau vao phat hanh hoac test (bin/, docs/, test/, ...) con thay doi chua commit - commit/stash truoc khi phat hanh.');
  const pushTag = () => git('push', 'origin', RELEASE_BRANCH, version);
  if (!hasTag(version)) {
    assertCanRelease();
    console.log(`Chua co tag ${version} - tao tag tai HEAD va day len...`);
    git('tag', '-a', version, '-m', version);
    pushTag();
    return;
  }
  if (git('diff', '--name-only', version, 'HEAD', '--', ...RELEASE_INPUTS)) {
    assertCanRelease();
    execSync('npm version patch --no-git-tag-version', { stdio: 'ignore' });
    pkg = readPkg();
    const previous = version;
    version = `v${pkg.version}`;
    console.log(`Ma nguon moi hon ${previous} - tang len ${version}, tao tag va day len...`);
    git('commit', '-m', pkg.version, '--', 'package.json', 'package-lock.json');
    git('tag', '-a', version, '-m', version);
    pushTag();
    return;
  }
  if (!git('ls-remote', '--tags', 'origin', version)) {
    console.log(`Tag ${version} chua len origin - day len...`);
    git('push', 'origin', version);
  }
}

const read = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };

/** Đăng nhập npm trước khi đụng tới deploy; nếu chưa có phiên thì mở luồng login tương tác. */
function ensureNpmLogin() {
  const whoami = () => {
    // Windows exposes npm as npm.cmd; execFileSync('npm', ...) cannot resolve it there.
    try { return execSync('npm whoami', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return ''; }
  };
  let user = whoami();
  if (!user) {
    console.log('Chưa đăng nhập npm - mở npm login...');
    execSync('npm login', { stdio: 'inherit' });
    user = whoami();
  }
  if (!user) throw new Error('npm login chưa hoàn tất. Đăng nhập npm rồi chạy lại publish.bat.');
  console.log(`Đã đăng nhập npm với tài khoản ${user}.`);
}

console.log('========================================================');
console.log('        AIVIN CLI - PHAT HANH PHIEN BAN MOI');
console.log('========================================================\n');

try {
  // Buoc 0: npm publish lay code tu thu muc lam viec -> cac tep vao goi npm phai sach va trung tag (trung voi ban CI build)
  console.log('[0/4] Kiem tra ma nguon khop tag...');
  ensureTaggedRelease();
  console.log(`Ma nguon sach, trung tag ${version}.`);

  // Đăng nhập trước khi deploy để không cập nhật site rồi mới phát hiện npm chưa đăng nhập.
  console.log('\n[0.5/4] Kiem tra dang nhap npm...');
  ensureNpmLogin();

  // Buoc 1: ban build trong dist phai dung la cua tag nay (dist/ cua ban cu khong bao gio duoc ky thanh ban moi)
  console.log(`\n[1/4] Kiem tra ban build cho ${version}...`);
  if (read(path.join(dist, 'RELEASE_TAG')) !== version || !fs.existsSync(path.join(dist, 'SHA256SUMS'))) {
    // CI do -> dung, khong ky gi; loi kem tom tat log.
    await waitForCiBuild(version, { repo: REPO, gh, sleep });
    console.log(`dist/ khong phai ban build ${version} - dang tai tu GitHub Release ${version}...`);
    execSync(`node scripts/release-fetch.mjs ${version}`, { stdio: 'inherit' });
  } else {
    console.log('Ban build da co san trong dist/.');
  }

  // Buoc 2: Ky ban phat hanh (bo qua neu chu ky san co da hop le cho ban nay - chay lai khong phai nhap mat khau)
  console.log('\n[2/4] Ky ban phat hanh...');
  let signed = false;
  try {
    verifyReleaseSignature({ version, sums: fs.readFileSync(path.join(dist, 'SHA256SUMS')), sigText: fs.readFileSync(path.join(dist, 'SHA256SUMS.sig'), 'utf8'), keys: RELEASE_PUBLIC_KEYS });
    signed = true;
  } catch { /* chua ky / chu ky khong khop -> ky lai */ }
  if (signed) console.log('Da co chu ky hop le.');
  else execSync('node scripts/sign-release.mjs', { stdio: 'inherit' });

  // Buoc 3: Publish len site get.aivin.vn (bo qua neu da dang - chay lai sau khi npm loi)
  console.log('\n[3/4] Dang ban phat hanh len get.aivin.vn...');
  if (read(path.join(site, 'latest.txt')) === version && fs.existsSync(path.join(site, version))) {
    console.log(`${version} da dang tren get.aivin.vn - bo qua.`);
  } else {
    execSync('node scripts/publish-get.mjs', { stdio: 'inherit' });
  }

  // Buoc 4: Publish len npm (bo qua neu phien ban da co tren npm; loi -> bao loi, khong bao thanh cong)
  console.log('\n[4/4] Xuat ban goi len npm...');
  let onNpm = '';
  try { onNpm = execSync(`npm view ${pkg.name}@${pkg.version} version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* chua co */ }
  if (onNpm === pkg.version) {
    console.log(`${pkg.name}@${pkg.version} da co tren npm - bo qua.`);
  } else {
    try {
      execSync('npm publish', { stdio: 'inherit' });
    } catch {
      throw new Error('Xuat ban npm chua thanh cong (get.aivin.vn da len ban moi). Neu chua dang nhap / het phien: `npm login`, roi chay lai publish.bat - cac buoc da xong se duoc bo qua.');
    }
    console.log(`\n Da xuat ban ${pkg.name}@${pkg.version} len npm thanh cong!`);
  }

  console.log('\n========================================================');
  console.log(`  HOAN TAT PHAT HANH PHIEN BAN ${version}!`);
  console.log('========================================================');
} catch (err) {
  console.error('\n[LOI]', err.message || err);
  process.exitCode = 1;
}
