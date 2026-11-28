import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { RELEASE_PUBLIC_KEYS } from '../bin/lib/releaseKeys.mjs';
import { verifyReleaseSignature } from '../bin/lib/selfUpdate.mjs';
import { NPM_JOB, runTool, waitForCiBuild, waitForCiJob, waitForNpmTrustedPublisher } from './release-ci.mjs';

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
// Deploy cua LightCode (cli-release.ps1) chay khong co terminal: khong the hoi OTP / mat khau. Ky dung mat khau DPAPI da luu tren may,
// npm chi qua CI (OIDC); chua khai Trusted publisher thi mo trinh duyet npmjs.com va tu chay lai job CI thay vi publish tu may.
const UNATTENDED = process.env.AIVIN_RELEASE_UNATTENDED === '1';
const NPM_SETTINGS_URL = 'https://www.npmjs.com/package/@aivin-labs/cli/access';
const openUrl = (url) => {
  if (process.platform === 'win32') execSync(`start "" "${url}"`, { stdio: 'ignore', shell: 'cmd.exe' });
  else execSync(`${process.platform === 'darwin' ? 'open' : 'xdg-open'} "${url}"`, { stdio: 'ignore' });
};
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

/**
 * npmjs.org khong cho publish de len mot version da tung staged va bi huy (409 "Cannot publish over previously staged version").
 * Khi gap loi nay, tang patch sang version moi, commit + tag + day len origin de chay lai tu dau cho ban moi.
 */
function bumpPatchAfterStagedConflict() {
  assertCanRelease();
  const previous = version;
  execSync('npm version patch --no-git-tag-version', { stdio: 'ignore' });
  pkg = readPkg();
  version = `v${pkg.version}`;
  console.log(`\nPhien ban ${previous.slice(1)} bi ket staged tren npm (E409) - tu dong tang len ${version}, tao tag va day len...`);
  git('commit', '-m', pkg.version, '--', 'package.json', 'package-lock.json');
  git('tag', '-a', version, '-m', version);
  git('push', 'origin', RELEASE_BRANCH, version);
}

const read = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };

// npm duoc publish tu CI (job npm-publish, trusted publishing OIDC - khong token, khong OTP). Chi khi CI chua publish duoc
// (trusted publisher chua cau hinh tren npmjs.com, job do...) moi publish tu may nay - duong lui duoi day.
// Tai khoan npm bat 2FA auth-and-writes: npm publish phai hoi OTP / xac thuc web ngay trong cua so publish.bat.
// npm chi hoi khi stdin/stdout la TTY -> chay voi stdio 'inherit' (truoc day pipe stdout -> khong hoi duoc, v1.0.81 loi).
// Loi doc lai tu log rieng (--logs-dir) vi khong con bat stdout; cli-release.ps1 cung doc thu muc nay de nhan dien E409.
const NPM_PUBLISH_LOGS = path.join(os.tmpdir(), 'aivin-cli-npm-publish');

/**
 * Lan publish truoc cua dung version nay da duoc npm nhan (PUT 202 "being processed") nhung chua hien tren `npm view`.
 * npmjs.org co the xu ly toi ~1 gio (v1.0.80: ~55 phut). Publish lai luc nay -> E409 "previously staged version"
 * -> bumpPatchAfterStagedConflict tang patch oan. Gap truong hop nay thi chi cho, khong publish lai.
 */
function npmPublishAccepted(ver) {
  let files = [];
  try { files = fs.readdirSync(NPM_PUBLISH_LOGS); } catch { return false; }
  return files.some((f) => {
    const log = read(path.join(NPM_PUBLISH_LOGS, f));
    return log.includes(`notice version: ${ver}`) && /PUT 202 \S*registry\.npmjs\.org/.test(log) && /verbose exit 0/.test(log);
  });
}

/** npm publish co tuong tac (OTP). Tra ve null khi thanh cong, nguoc lai la noi dung log loi. */
function npmPublish() {
  fs.rmSync(NPM_PUBLISH_LOGS, { recursive: true, force: true });
  fs.mkdirSync(NPM_PUBLISH_LOGS, { recursive: true });
  try {
    execSync(`npm publish --logs-dir="${NPM_PUBLISH_LOGS}"`, { stdio: 'inherit' });
    return null;
  } catch (e) {
    const logs = fs.readdirSync(NPM_PUBLISH_LOGS).map((f) => read(path.join(NPM_PUBLISH_LOGS, f))).join('\n');
    return `${logs}\n${e?.message || ''}`;
  }
}

const NPM_VISIBLE_TRIES = 20;
const NPM_VISIBLE_POLL_MS = 15_000;
const npmViewVersion = () => {
  try { return execSync(`npm view ${pkg.name}@${pkg.version} version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};

/**
 * Job CI npm-publish da publish ban nay chua (cho job xong neu dang chay)? Xanh -> cho `npm view` thay ban moi (toi ~5 phut); van chua thay
 * thi coi nhu npm dang xu ly, KHONG publish lai. Do / khong co job / khong hoi duoc -> false: publish tu may (can OTP).
 */
async function npmPublishedByCi() {
  const state = await waitForCiJob(version, NPM_JOB, { repo: REPO, gh, sleep });
  if (state !== 'success') {
    console.log(`CI chua publish npm cho ${version} (job ${NPM_JOB}: ${state}) - publish tu may nay (can OTP 2FA).`);
    console.log('  Kiem tra trusted publisher tren npmjs.com: @aivin-labs/cli -> Settings -> Trusted publishing (aivin-labs/cli, release.yml, cho phep npm publish).');
    return false;
  }
  for (let i = 0; i < NPM_VISIBLE_TRIES; i++) {
    if (npmViewVersion() === pkg.version) {
      console.log(`CI da publish ${pkg.name}@${pkg.version} len npm (trusted publishing).`);
      return true;
    }
    if (i === 0) console.log(`CI da publish ${pkg.name}@${pkg.version}, cho npm hien ban moi...`);
    await sleep(NPM_VISIBLE_POLL_MS);
  }
  console.log(`CI da publish ${pkg.name}@${pkg.version} nhung npm chua hien (dang xu ly, co the toi ~1 gio). Khong publish lai; kiem tra sau: npm view ${pkg.name}@${pkg.version} version`);
  return true;
}

/** Dang nhap npm - chi can khi publish tu may (duong lui khi CI chua publish duoc); chua co phien thi mo npm login tuong tac. */
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

/** Chay buoc 1 -> 4 cho version hien tai (tai CI build -> ky -> publish get.aivin.vn -> publish npm). */
async function publishCurrentVersion({ allowStagedRetry = true } = {}) {
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
  if (npmViewVersion() === pkg.version) {
    console.log(`${pkg.name}@${pkg.version} da co tren npm - bo qua.`);
  } else if (npmPublishAccepted(pkg.version)) {
    console.log(`npm da nhan ${pkg.name}@${pkg.version} (202, dang xu ly - co the toi ~1 gio). Khong publish lai (se bi E409); cho roi kiem tra: npm view ${pkg.name}@${pkg.version} version`);
  } else if (await npmPublishedByCi()) {
    // CI da publish (OIDC): khong publish lai tu may (se E409).
  } else if (UNATTENDED) {
    // Khong co terminal de hoi OTP: hoi nguoi dung qua trinh duyet (khai Trusted publisher), roi chay lai job CI.
    console.log('::deploy-result summary=Cho ban khai Trusted publisher tren npmjs.com (da mo trinh duyet)');
    const state = await waitForNpmTrustedPublisher(version, NPM_JOB, { repo: REPO, gh, sleep, openUrl, settingsUrl: NPM_SETTINGS_URL });
    if (state !== 'success') {
      throw new Error(`Job ${NPM_JOB} van chua publish duoc npm (${state}). Khai Trusted publisher tren ${NPM_SETTINGS_URL} roi bam Deploy lai - cac buoc da xong se duoc bo qua.`);
    }
    console.log(`CI da publish ${pkg.name}@${pkg.version} len npm (trusted publishing).`);
  } else {
    ensureNpmLogin();
    const errOut = npmPublish();
    if (errOut !== null) {
      if (allowStagedRetry && /previously staged version|E409/i.test(errOut)) {
        bumpPatchAfterStagedConflict();
        return publishCurrentVersion({ allowStagedRetry: false });
      }
      throw new Error('Xuat ban npm chua thanh cong (get.aivin.vn da len ban moi). Neu chua dang nhap / het phien: `npm login`, roi chay lai publish.bat - cac buoc da xong se duoc bo qua.');
    }
    console.log(`\n Da xuat ban ${pkg.name}@${pkg.version} len npm thanh cong!`);
  }
}

try {
  // Buoc 0: npm publish lay code tu thu muc lam viec -> cac tep vao goi npm phai sach va trung tag (trung voi ban CI build)
  console.log('[0/4] Kiem tra ma nguon khop tag...');
  ensureTaggedRelease();
  console.log(`Ma nguon sach, trung tag ${version}.`);


  await publishCurrentVersion();

  console.log('\n========================================================');
  console.log(`  HOAN TAT PHAT HANH PHIEN BAN ${version}!`);
  console.log('========================================================');
} catch (err) {
  console.error('\n[LOI]', err.message || err);
  process.exitCode = 1;
}
