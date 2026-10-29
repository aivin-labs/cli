/**
 * Biểu tượng Aivin trên thanh menu macOS (29/10/2026) — JavaScript for Automation (`osascript -l JavaScript`, cầu nối ObjC tới Cocoa), có sẵn
 * trên mọi máy Mac nên không phải biên dịch / ký. Chạy trong gói ~/Applications/Aivin.app (mac.mjs), LaunchAgent com.aivin.remote mở nó
 * lúc đăng nhập. Như Aivin.exe trên Windows: biểu tượng + menu (trạng thái, kết nối bằng mã, tạm dừng, mở khi đăng nhập, thư mục, thoát) và
 * giữ `aivin-remote-run.sh` chạy (mã 0 → chờ tới khi máy rảnh lại, 75 → chạy lại ngay, khác → giãn dần tới 5 phút; tự lùi bản nằm trong
 * kịch bản đó). `@@HOME@@` = thư mục cấu hình (chuỗi JSON). Không dùng template literal ở đây (mã nằm trong String.raw).
 */
export const MAC_TRAY_JS = String.raw`ObjC.import('Cocoa');
ObjC.import('stdlib');

var HOME = @@HOME@@;
var CREDS = HOME + '/device-credentials.json';
var LOCK = HOME + '/remote-daemon.lock';
var PAUSED = HOME + '/remote-paused';
var DESK = HOME + '/desktop';
var CFG = DESK + '/launch.cfg';
var LOGO = DESK + '/logo.png';
var PIDFILE = DESK + '/tray.pid';
var OPEN_REQ = DESK + '/open-request';
var QUIT_REQ = DESK + '/quit-request';
var RESTART_CODE = 75;

var fm = $.NSFileManager.defaultManager;
var sa = Application.currentApplication();
sa.includeStandardAdditions = true;

function exists(p) { return fm.fileExistsAtPath(p); }
function read(p) {
  var s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
  return s.isNil() ? null : ObjC.unwrap(s);
}
function write(p, text) { $(text).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null); }
function remove(p) { if (exists(p)) fm.removeItemAtPathError(p, null); }
function mtime(p) {
  var a = fm.attributesOfItemAtPathError(p, null);
  return a.isNil() ? 0 : a.objectForKey($.NSFileModificationDate).timeIntervalSince1970;
}
function task(path, args) {
  var t = $.NSTask.alloc.init;
  t.launchPath = path;
  t.arguments = $(args);
  return t;
}
function runWait(path, args) {
  try { var t = task(path, args); t.launch; t.waitUntilExit; return t.terminationStatus; } catch (e) { return -1; }
}
function output(path, args) {
  try {
    var t = task(path, args);
    var pipe = $.NSPipe.pipe;
    t.standardOutput = pipe;
    t.standardError = $.NSFileHandle.fileHandleWithNullDevice;
    t.launch;
    var data = pipe.fileHandleForReading.readDataToEndOfFile;
    t.waitUntilExit;
    return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
  } catch (e) {
    return '';
  }
}
function notify(text) { try { sa.displayNotification(text, { withTitle: 'AIVIN Bot CLI' }); } catch (e) {} }

function loadCfg() {
  var c = { exe: null, args: [], s: {}, extra: {} };
  var lines = (read(CFG) || '').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var at = lines[i].indexOf('=');
    if (at <= 0) continue;
    var k = lines[i].slice(0, at), v = lines[i].slice(at + 1);
    if (k === 'exe') c.exe = v;
    else if (k === 'arg') c.args.push(v);
    else if (k.indexOf('s.') === 0) c.s[k.slice(2)] = v;
    else c.extra[k] = v;
  }
  return c;
}
var cfg = loadCfg();
function T(k) { return cfg.s[k] || k; }

// --- Trình giữ chạy ----------------------------------------------------------------------------------------------------------------

var child = null, childPid = 0, childStarted = 0, nextStart = 0, delay = 10, pairing = false, quitting = false;
var wasPaired = exists(CREDS);
var seenOpen = mtime(OPEN_REQ), seenQuit = mtime(QUIT_REQ);

/** Khoá daemon còn được làm mới (< 90 s) bởi tiến trình khác tiến trình con vừa thoát của mình (nó có thể sập mà không xoá khoá). */
function lockHeld() {
  var s = read(LOCK);
  if (!s) return false;
  try {
    var d = JSON.parse(s);
    if (Number(d.pid) === childPid && !child) return false;
    var at = Date.parse(d.beat_at || d.started_at || '');
    return !isFinite(at) || Date.now() - at < 90000;
  } catch (e) {
    return false;
  }
}

function backoff() {
  nextStart = Date.now() + delay * 1000;
  delay = Math.min(delay * 2, 300);
}

function startChild(code) {
  cfg = loadCfg();
  if (!cfg.exe) return;
  var args = cfg.args.slice();
  if (code) args.push('--code', code);
  try {
    var t = task(cfg.exe, args);
    t.currentDirectoryPath = $.NSHomeDirectory();
    t.launch;
    child = t;
    childPid = t.processIdentifier;
    childStarted = Date.now();
    pairing = !!code;
  } catch (e) {
    child = null;
    backoff();
  }
}

function onChildExit() {
  var rc = child.terminationStatus;
  var secs = (Date.now() - childStarted) / 1000;
  child = null;
  var wasPairing = pairing;
  pairing = false;
  if (wasPairing && !exists(CREDS)) { notify(T('pairFailed')); return; }
  if (rc === 0) { nextStart = Date.now() + 60000; return; }
  if (rc === RESTART_CODE) { nextStart = Date.now() + 1000; return; }
  if (secs > 300) delay = 10;
  backoff();
}

function killChild() {
  var c = child;
  child = null;
  if (!c || !c.isRunning) return;
  // aivin-remote-run.sh chờ daemon (không exec) — dừng con của nó trước rồi tới nó.
  runWait('/usr/bin/pkill', ['-TERM', '-P', String(c.processIdentifier)]);
  try { c.terminate; } catch (e) {}
}

function running() { return (child && child.isRunning) || lockHeld(); }

function tick() {
  if (quitting) return;
  if (mtime(QUIT_REQ) > seenQuit) { quit(); return; }
  if (child && !child.isRunning) onChildExit();
  var paired = exists(CREDS);
  if (paired && !wasPaired) notify(T('connected'));
  wasPaired = paired;
  if (!child && paired && Date.now() >= nextStart && !lockHeld()) startChild(null);
  var req = mtime(OPEN_REQ);
  if (req > seenOpen) { seenOpen = req; openAivin(); }
  refresh();
}

// --- Menu --------------------------------------------------------------------------------------------------------------------------

var app = $.NSApplication.sharedApplication;
var item, menu, statusItem, openItem, pauseItem, startupItem, target;

function startupEnabled() { return !!cfg.extra.agent && exists(cfg.extra.agent); }

function setStartup(on) {
  var agent = cfg.extra.agent, copy = cfg.extra.agent_copy;
  if (!agent) return;
  if (on) {
    if (copy && exists(copy) && !exists(agent)) fm.copyItemAtPathToPathError(copy, agent, null);
  } else {
    remove(agent);
  }
}

function refresh() {
  var paired = exists(CREDS), paused = exists(PAUSED), up = running();
  var state = !paired ? T(pairing ? 'connecting' : 'notPaired') : !up ? T('stopped') : paused ? T('paused') : T('running');
  statusItem.title = state;
  item.button.toolTip = 'Aivin - ' + state;
  item.button.appearsDisabled = !(paired && up && !paused);
  openItem.title = T(paired ? 'open' : 'connect');
  openItem.hidden = paired;
  pauseItem.title = T(paused ? 'resume' : 'pause');
  pauseItem.hidden = !paired;
  startupItem.state = startupEnabled() ? 1 : 0;
}

function askCode() {
  app.activateIgnoringOtherApps(true);
  var r;
  try {
    r = sa.displayDialog(T('pairPrompt'), {
      defaultAnswer: '', buttons: [T('pairCancel'), T('pairOk')], defaultButton: T('pairOk'), cancelButton: T('pairCancel'), withTitle: 'AIVIN Bot CLI',
    });
  } catch (e) {
    return;
  }
  var code = String(r.textReturned || '').trim().toUpperCase();
  if (!code || quitting) return;
  killChild();
  startChild(code);
  refresh();
}

/** Mở lại Aivin (Spotlight / Launchpad khi đang chạy): chưa ghép máy → hỏi mã; có rồi → mở menu, chạy daemon ngay nếu đang không chạy. */
function openAivin() {
  if (quitting) return;
  if (!exists(CREDS)) { askCode(); return; }
  if (!child && !lockHeld()) { nextStart = 0; delay = 10; tick(); }
  try { item.button.performClick(null); } catch (e) {}
}

function togglePause() {
  if (exists(PAUSED)) remove(PAUSED);
  else write(PAUSED, new Date().toISOString());
  refresh();
}

function quit() {
  if (quitting) return;
  quitting = true;
  killChild();
  remove(PIDFILE);
  $.exit(0);
}

function addItem(title, action) {
  var mi = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, action, '');
  if (action) mi.target = target;
  menu.addItem(mi);
  return mi;
}

function buildUi() {
  ObjC.registerSubclass({
    name: 'AivinTrayTarget',
    methods: {
      'onOpen:': { types: ['void', ['id']], implementation: function () { openAivin(); } },
      'onPause:': { types: ['void', ['id']], implementation: function () { togglePause(); } },
      'onStartup:': { types: ['void', ['id']], implementation: function () { setStartup(!startupEnabled()); refresh(); } },
      'onFolder:': { types: ['void', ['id']], implementation: function () { task('/usr/bin/open', [HOME]).launch; } },
      'onQuit:': { types: ['void', ['id']], implementation: function () { quit(); } },
      'tick:': { types: ['void', ['id']], implementation: function () { try { tick(); } catch (e) { console.log('aivin tray: ' + e); } } },
      'applicationShouldHandleReopen:hasVisibleWindows:': { types: ['bool', ['id', 'bool']], implementation: function () { openAivin(); return false; } },
    },
  });
  target = $.AivinTrayTarget.alloc.init;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  app.delegate = target;

  item = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
  var img = $.NSImage.alloc.initWithContentsOfFile(LOGO);
  if (img.isNil()) item.button.title = 'AIVIN Bot CLI';
  else { img.size = $.NSMakeSize(18, 18); item.button.image = img; }

  menu = $.NSMenu.alloc.init;
  menu.autoenablesItems = false;
  statusItem = addItem('AIVIN Bot CLI', null);
  statusItem.enabled = false;
  menu.addItem($.NSMenuItem.separatorItem);
  openItem = addItem(T('connect'), 'onOpen:');
  pauseItem = addItem(T('pause'), 'onPause:');
  startupItem = addItem(T('startup'), 'onStartup:');
  addItem(T('folder'), 'onFolder:');
  menu.addItem($.NSMenuItem.separatorItem);
  addItem(T('quit'), 'onQuit:');
  item.menu = menu;
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(2, target, 'tick:', $(), true);
}

function run(argv) {
  var has = function (flag) { return argv.indexOf(flag) >= 0; };
  var me = $.NSProcessInfo.processInfo.processIdentifier;
  var other = parseInt(read(PIDFILE) || '0', 10);
  // Đã có một bản chạy: mở lần nữa = mở Aivin; --quit = bảo bản đó thoát (qua tệp yêu cầu, bản đang chạy đọc mỗi 2 s).
  if (other && other !== me && output('/bin/ps', ['-p', String(other), '-o', 'command=']).indexOf('tray.js') >= 0) {
    if (has('--quit')) write(QUIT_REQ, String(Date.now()));
    else if (!has('--autostart') && !has('--installed')) write(OPEN_REQ, String(Date.now()));
    return;
  }
  if (has('--quit')) return;
  write(PIDFILE, String(me));
  buildUi();
  tick();
  if (has('--installed')) notify(T(wasPaired ? 'firstRun' : 'connectHint'));
  else if (!has('--autostart')) { if (wasPaired) notify(T('firstRun')); openAivin(); }
  app.run;
}
`;
