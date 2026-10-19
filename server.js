/**
 * 今日事 · 本地后台小服务（server.js）
 * 只用 Node 内置模块（CommonJS）。职责：静态页托管 + 任务同步 + 提醒调度 + 弹窗通知 + 备份 + 日志。
 * 接口字段名已冻结，前端依赖，不要改名。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

/* ============================== 常量 ============================== */
const SERVER_DIR = __dirname;
const SERVER_FILE = path.join(SERVER_DIR, 'server.js');
const SERVER_NAME = 'today-server';
const VERSION = 1;
// 已知可用的 AUMID（Windows PowerShell 自身的通知标识）
const TOAST_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'TodayServer';
const PORT_TRIES = 10;                    // 起始端口起最多再试 10 个
const DEFAULT_CATCHUP_HOURS = 12;         // 补提醒时间窗
const FIRED_KEEP_MS = 24 * 3600 * 1000;   // fired 记录保留时长（覆盖 12 小时窗口）
const RERING_INTERVAL_MS = 5 * 60 * 1000; // 重要提醒重响间隔
const RERING_MAX = 6;                     // 重要提醒最多重响次数
const BACKUP_THROTTLE_MS = 5 * 60 * 1000; // 自动备份节流
const BACKUP_KEEP = 50;                   // 备份保留份数
const LOG_MAX_BYTES = 1024 * 1024;        // 日志轮转阈值
const TEXT_MAX = 120;                     // 通知正文截断长度
const RECENT_FIRED_MAX = 50;
const RECENT_FIRED_WINDOW_MS = 12 * 3600 * 1000;
const MAX_BODY = 16 * 1024 * 1024;        // 请求体上限
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const STATIC_MAP = { '/': 'index.html', '/app.ico': 'app.ico' }; // 其余路径一律 404
/* ============================ 命令行参数 ============================ */
const USAGE = [
  '今日事 · 后台小服务', '', '用法：node server.js [选项]', '', '选项：',
  '  --port=N             起始端口（默认 8788，最多向后尝试 10 个端口）',
  '  --data-dir=PATH      数据目录（默认 <脚本目录>\\data）',
  '  --backup-dir=PATH    备份目录（默认 <脚本目录>\\backups）',
  '  --dry-run            只把要弹出的通知写进日志，不真正弹窗',
  '  --install-autostart  安装开机自启后退出',
  '  --remove-autostart   取消开机自启后退出',
  '  --help               显示本帮助', '',
  'HTTP 接口：GET /api/ping · GET|POST /api/state · POST /api/reminders',
  '          GET /api/backups · GET|POST /api/backup · POST /api/quit',
].join('\r\n');

function parseArgs(argv) {
  const o = { port: 8788, dataDir: '', backupDir: '', dryRun: false, install: false, remove: false, help: false };
  for (const a of argv) {
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--install-autostart') o.install = true;
    else if (a === '--remove-autostart') o.remove = true;
    else if (a === '--help' || a === '-h' || a === '/?') o.help = true;
    else if (a.startsWith('--port=')) { const n = parseInt(a.slice(7), 10); if (Number.isFinite(n) && n > 0 && n < 65536) o.port = n; }
    else if (a.startsWith('--data-dir=')) o.dataDir = a.slice(11);
    else if (a.startsWith('--backup-dir=')) o.backupDir = a.slice(13);
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const DATA_DIR = path.resolve(opts.dataDir || path.join(SERVER_DIR, 'data'));
const BACKUP_DIR = path.resolve(opts.backupDir || path.join(SERVER_DIR, 'backups'));
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.json');
const LOG_FILE = path.join(DATA_DIR, 'server.log');
const NOTIFY_ERR_LOG = path.join(DATA_DIR, 'notify-error.log');

/* ============================== 日志 ============================== */
function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  try { if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (_) { /* 首次写入时文件还不存在 */ }
  try { fs.appendFileSync(LOG_FILE, line + '\r\n'); } catch (_) { /* 写日志失败不影响主流程 */ }
  if (level === 'ERROR') console.error(line); else console.log(line);
}
/* ========================= 文件工具（原子写） ========================= */
function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { if (e.code !== 'EEXIST') log('ERROR', `创建目录失败 ${dir}：${e.message}`); } }

function writeFileAtomic(file, text) { // 先写 .tmp 再 rename（Windows 上 rename 会覆盖目标）
  fs.writeFileSync(file + '.tmp', text, 'utf8');
  fs.renameSync(file + '.tmp', file);
}

function readJsonFile(file) { // 损坏/缺失一律当空数据，绝不把异常抛出去
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? JSON.parse(text) : null;
  } catch (e) {
    if (e.code !== 'ENOENT') log('ERROR', `读取 ${path.basename(file)} 失败，按空数据处理：${e.message}`);
    return null;
  }
}
/* ============================== 任务模型 ============================== */
function hash32(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

/** 缺失字段兜底；非对象返回 null 表示丢弃。 */
function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = Object.assign({}, raw);
  if (typeof t.id !== 'string' || t.id === '') t.id = 'auto-' + hash32(JSON.stringify(raw));
  if (typeof t.text !== 'string') t.text = t.text == null ? '' : String(t.text);
  if (typeof t.done !== 'boolean') t.done = !!t.done;
  const upd = Number(t.updatedAt), cre = Number(t.createdAt);
  t.updatedAt = Number.isFinite(upd) ? upd : (Number.isFinite(cre) ? cre : Date.now());
  t.createdAt = Number.isFinite(cre) ? cre : t.updatedAt;
  return t;
}

function normalizeTasks(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = normalizeTask(raw);
    if (t) out.push(t); else log('ERROR', '忽略了一条非法任务（不是对象）');
  }
  return out;
}

/** 并集合并：顺序以提交方为准，仅追加服务端独有的任务；同 id 取 updatedAt 更大的（相等保留提交方，保证幂等）。 */
function mergeTasks(submitted, disk) {
  const diskById = new Map();
  for (const t of disk) if (!diskById.has(t.id)) diskById.set(t.id, t);
  const out = [], index = new Map();
  for (const t of submitted) {
    const at = index.get(t.id);
    if (at !== undefined) { if (t.updatedAt > out[at].updatedAt) out[at] = t; continue; } // 提交方内部重复 id
    index.set(t.id, out.length);
    const d = diskById.get(t.id);
    out.push(d && d.updatedAt > t.updatedAt ? d : t);
  }
  for (const d of disk) if (!index.has(d.id)) out.push(d);
  return out;
}
/* ============================== 状态 ============================== */
const state = { revision: 0, savedAt: null, tasks: [] };
const rem = { items: {}, fired: {} }; // 待发提醒 + 已触发集合
const firedInfo = new Map();          // key → {taskId,text,at}，供 /api/ping 回放
let catchupHours = DEFAULT_CATCHUP_HOURS;
let lastBackupAt = 0, saveTimer = null, shuttingDown = false;

function loadState() {
  const raw = readJsonFile(TASKS_FILE);
  if (raw && typeof raw === 'object') {
    state.tasks = normalizeTasks(raw.tasks);
    state.revision = Number(raw.revision) || 0;
    state.savedAt = Number.isFinite(Number(raw.savedAt)) ? Number(raw.savedAt) : null;
  }
  log('INFO', `已载入任务 ${state.tasks.length} 条（revision=${state.revision}）`);
}

function saveState() {
  try { writeFileAtomic(TASKS_FILE, JSON.stringify({ revision: state.revision, savedAt: state.savedAt, tasks: state.tasks }, null, 2)); }
  catch (e) { log('ERROR', `保存 tasks.json 失败：${e.message}`); }
}

function normalizeReminder(raw, prev) {
  if (!raw || typeof raw !== 'object') return null;
  const taskId = raw.taskId == null ? '' : String(raw.taskId);
  let key = raw.key == null ? '' : String(raw.key);
  if (!key) key = taskId ? `${taskId}@${Number(raw.at) || 0}` : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const at = Number(raw.at), rawFired = Number(raw.firedAt);
  return {
    key, taskId, text: raw.text == null ? '' : String(raw.text), persist: !!raw.persist,
    at: Number.isFinite(at) ? at : Date.now(),
    // firedAt/count 由服务端维护，前端重复提交同 key 时沿用旧值（重响逻辑依赖它）
    firedAt: prev && Number.isFinite(prev.firedAt) ? prev.firedAt : (Number.isFinite(rawFired) ? rawFired : null),
    count: prev && Number.isFinite(prev.count) ? prev.count : (Number.isFinite(Number(raw.count)) ? Number(raw.count) : 0),
  };
}

function loadReminders() {
  const raw = readJsonFile(REMINDERS_FILE);
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw.items && typeof raw.items === 'object' ? raw.items : {})) {
      const n = normalizeReminder(Object.assign({ key: k }, v || {}), null);
      if (n) rem.items[n.key] = n;
    }
    for (const [k, v] of Object.entries(raw.fired && typeof raw.fired === 'object' ? raw.fired : {})) {
      if (Number.isFinite(Number(v))) rem.fired[k] = Number(v);
    }
  }
  // 重启后仍能补提醒：用 items 重建回放信息
  for (const [k, it] of Object.entries(rem.items)) if (rem.fired[k]) firedInfo.set(k, { taskId: it.taskId, text: it.text, at: it.at });
  pruneFired();
  log('INFO', `已载入提醒 ${Object.keys(rem.items).length} 条（已触发 ${Object.keys(rem.fired).length} 条）`);
}

function pruneFired() { // 清掉过期记录，避免 fired 无限增长
  const now = Date.now();
  for (const [k, ts] of Object.entries(rem.fired)) if (!Number.isFinite(ts) || now - ts > FIRED_KEEP_MS) { delete rem.fired[k]; firedInfo.delete(k); }
}

function saveReminders() {
  pruneFired();
  try { writeFileAtomic(REMINDERS_FILE, JSON.stringify({ items: rem.items, fired: rem.fired, updatedAt: Date.now() }, null, 2)); }
  catch (e) { log('ERROR', `保存 reminders.json 失败：${e.message}`); }
}

function scheduleRemindersSave() { // 落盘防抖 1 秒
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; saveReminders(); }, 1000);
}
/* ============================== 备份 ============================== */
function pad2(n) { return String(n).padStart(2, '0'); }

function backupStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}
function pruneBackups() {
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR); } catch (_) { return; }
  const files = names.filter((n) => /^todo-\d{8}-\d{6}\.json$/.test(n)).sort(); // 文件名即时间序
  for (const n of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, n)); } catch (_) { /* 删不掉就留着 */ }
  }
}

/** force=true 不受 5 分钟节流限制（手动 / 启动 / 退出）。返回文件名或 null。 */
function makeBackup(tasks, force) {
  const now = Date.now();
  if (!force && now - lastBackupAt < BACKUP_THROTTLE_MS) return null;
  const name = `todo-${backupStamp(now)}.json`;
  try {
    ensureDir(BACKUP_DIR);
    writeFileAtomic(path.join(BACKUP_DIR, name), JSON.stringify(Array.isArray(tasks) ? tasks : [], null, 2));
  } catch (e) { log('ERROR', `生成备份失败：${e.message}`); return null; }
  lastBackupAt = now;
  pruneBackups();
  log('INFO', `已生成备份 ${name}`);
  return name;
}

function listBackups() {
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR); } catch (_) { return []; }
  const items = [];
  for (const n of names) {
    if (!/^todo-\d{8}-\d{6}\.json$/.test(n)) continue;
    try { const st = fs.statSync(path.join(BACKUP_DIR, n)); items.push({ name: n, size: st.size, savedAt: Math.round(st.mtimeMs) }); } catch (_) { /* 跳过 */ }
  }
  items.sort((a, b) => b.savedAt - a.savedAt);
  return items.slice(0, BACKUP_KEEP);
}
/* ============================== 通知 ============================== */
function truncate(s, n = TEXT_MAX) { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }

function fmtTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 三级降级脚本：1) 带 AUMID 的 WinRT Toast  2) 无 AUMID 的 Toast  3) NotifyIcon 气泡。
 * 整段 try/catch 包住，失败只写 notify-error.log，绝不影响 Node 进程。
 */
function buildNotifyScript(title, body, timeText) {
  const q = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "''").replace(/[\r\n]+/g, ' ') + "'";
  const xml = "'<toast scenario=\"reminder\"><visual><binding template=\"ToastGeneric\"><text>' + (Esc $title) + '</text><text>'"
    + " + (Esc $body) + '</text><text>' + (Esc $timeText) + '</text></binding></visual>"
    + "<audio src=\"ms-winsoundevent:Notification.Reminder\" /></toast>'";
  return [
    "$ErrorActionPreference = 'Stop'",
    '$title = ' + q(title), '$body = ' + q(body), '$timeText = ' + q(timeText), '$errLog = ' + q(NOTIFY_ERR_LOG),
    "function Esc([string]$s) { if ($null -eq $s) { return '' }; return $s.Replace('&','&amp;').Replace('<','&lt;').Replace('>','&gt;') }",
    'function LogErr([string]$m) { try { Add-Content -LiteralPath $errLog -Value ("[" + (Get-Date).ToString("o") + "] [ERROR] " + $m) -Encoding UTF8 } catch { } }',
    'function Show-Toast([string]$aumid) {',
    '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
    '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null',
    '  $xml = ' + xml,
    '  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument; $doc.LoadXml($xml)',
    '  $toast = New-Object Windows.UI.Notifications.ToastNotification -ArgumentList $doc',
    '  if ([string]::IsNullOrEmpty($aumid)) { [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier().Show($toast) }',
    '  else { [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast) }',
    '}',
    'function Show-Balloon() {',
    '  Add-Type -AssemblyName System.Windows.Forms; try { Add-Type -AssemblyName System.Drawing } catch { }',
    '  $ni = New-Object System.Windows.Forms.NotifyIcon',
    '  $ni.Icon = [System.Drawing.SystemIcons]::Information',
    '  $ni.BalloonTipTitle = $title; $ni.BalloonTipText = $body; $ni.Visible = $true',
    '  $ni.ShowBalloonTip(10000); Start-Sleep -Seconds 10', // 不等 10 秒气泡会立刻消失
    '  $ni.Visible = $false; $ni.Dispose()',
    '}',
    'try {',
    '  try { Show-Toast ' + q(TOAST_AUMID) + ' }',
    "  catch { LogErr ('带 AUMID 的 Toast 失败：' + $_.Exception.Message); try { Show-Toast '' }",
    "    catch { LogErr ('默认 Toast 失败：' + $_.Exception.Message); Show-Balloon } }",
    "} catch { LogErr ('通知全部失败：' + $_.Exception.Message) }",
  ].join('\r\n');
}

/** 弹通知；--dry-run 下只写日志。子进程 detached + unref，不等待。 */
function notify(title, body, timeText) {
  const text = truncate(body);
  if (opts.dryRun) { log('INFO', `[dry-run] 通知：${title} | ${text} | ${timeText}`); return; }
  try {
    const encoded = Buffer.from(buildNotifyScript(title, text, timeText), 'utf16le').toString('base64'); // 中文/引号安全
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => log('ERROR', `通知进程启动失败：${e.message}`));
    child.unref();
    log('INFO', `已发送通知：${text}`);
  } catch (e) { log('ERROR', `通知异常：${e.message}`); }
}

function notifyReminder(item, isRering) { notify('今日事', (isRering ? '[未处理] ' : '') + truncate(item.text || '（无内容）'), fmtTime(item.at || Date.now())); }

function recentFired() { // 最近 12 小时已触发，按触发时间倒序，最多 50 条
  const now = Date.now(), out = [];
  for (const [key, ts] of Object.entries(rem.fired)) {
    if (!Number.isFinite(ts) || now - ts > RECENT_FIRED_WINDOW_MS) continue;
    const info = firedInfo.get(key) || rem.items[key] || {};
    out.push({ key, taskId: info.taskId == null ? '' : String(info.taskId), text: info.text == null ? '' : String(info.text), at: Number(info.at) || ts, _ts: ts });
  }
  out.sort((a, b) => b._ts - a._ts);
  return out.slice(0, RECENT_FIRED_MAX).map((x) => ({ key: x.key, taskId: x.taskId, text: x.text, at: x.at }));
}
/* ============================== 调度 ============================== */
function markFired(item, now, firstTime) {
  if (firstTime) { rem.fired[item.key] = now; firedInfo.set(item.key, { taskId: item.taskId, text: item.text, at: item.at }); }
  item.firedAt = now;
  item.count = (Number(item.count) || (firstTime ? 0 : 1)) + 1;
}

function tick() {
  const now = Date.now();
  let dirty = false;
  for (const item of Object.values(rem.items)) {
    const firstFired = rem.fired[item.key];
    if (!firstFired) { // 到点：弹一次并记 fired
      if (Number(item.at) <= now) { notifyReminder(item, false); markFired(item, now, true); dirty = true; }
      continue;
    }
    if (!item.persist) continue; // 重要提醒：没被前端取消（仍在 items 里）就重响，最多 6 次
    const last = Number(item.firedAt) || firstFired;
    if (Math.max(0, (Number(item.count) || 1) - 1) < RERING_MAX && now - last >= RERING_INTERVAL_MS) {
      notifyReminder(item, true);
      markFired(item, now, false);
      dirty = true;
    }
  }
  if (dirty) scheduleRemindersSave();
}

/** 启动补提醒：窗口内合并成一条补发；窗口外静默作废（避免刷屏）。 */
function catchupOnStartup() {
  const now = Date.now(), winStart = now - catchupHours * 3600 * 1000;
  const missed = [], silent = [];
  for (const item of Object.values(rem.items)) {
    if (rem.fired[item.key] || Number(item.at) > now) continue;
    (Number(item.at) < winStart ? silent : missed).push(item);
  }
  if (missed.length) {
    const names = missed.slice(0, 3).map((it) => truncate(it.text || '（无内容）', 20)).join('、');
    notify('今日事', `错过 ${missed.length} 条提醒：${names}${missed.length > 3 ? ` 等 ${missed.length} 条` : ''}`, fmtTime(now));
  }
  for (const item of missed.concat(silent)) markFired(item, now, true);
  if (missed.length || silent.length) log('INFO', `补提醒：补发 ${missed.length} 条，静默作废 ${silent.length} 条`);
  saveReminders();
}
/* ============================== HTTP ============================== */
function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length }, CORS_HEADERS));
  res.end(buf);
}
function readBody(req, cb) {
  const chunks = [];
  let size = 0, done = false;
  const finish = (err, text) => { if (done) return; done = true; cb(err, text); };
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { finish(new Error('请求体过大')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
  req.on('error', (e) => finish(e));
  req.on('aborted', () => finish(new Error('请求中断')));
}

function readJsonBody(req, res, cb) {
  readBody(req, (err, text) => {
    if (err) return sendJson(res, 400, { ok: false, error: err.message });
    if (!text || !text.trim()) return cb({});
    try { cb(JSON.parse(text)); } catch (e) { sendJson(res, 400, { ok: false, error: 'JSON 解析失败：' + e.message }); }
  });
}

function isLocal(req) { const a = (req.socket && req.socket.remoteAddress) || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }

function pingPayload() {
  return {
    ok: true, name: SERVER_NAME, version: VERSION, port: currentPort, pid: process.pid,
    node: process.version, dryRun: !!opts.dryRun, now: Date.now(), recentFired: recentFired(),
  };
}

function handleStatic(pathname, res) {
  const rel = STATIC_MAP[pathname];
  if (!rel) return sendJson(res, 404, { ok: false, error: 'not found' });
  const root = path.resolve(SERVER_DIR), abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return sendJson(res, 403, { ok: false, error: 'forbidden' }); // 目录穿越防护
  fs.readFile(abs, (err, buf) => {
    if (err) return sendJson(res, 404, { ok: false, error: 'not found' });
    const head = { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-cache' };
    res.writeHead(200, Object.assign(head, CORS_HEADERS));
    res.end(buf);
  });
}

function handleStatePost(req, res) {
  readJsonBody(req, res, (data) => {
    state.tasks = mergeTasks(normalizeTasks(data.tasks), state.tasks);
    state.revision = Math.max(Number(state.revision) || 0, Number(data.revision) || 0) + 1;
    state.savedAt = Date.now();
    saveState();
    makeBackup(state.tasks, false); // 受 5 分钟节流限制
    sendJson(res, 200, { ok: true, revision: state.revision, savedAt: state.savedAt, tasks: state.tasks });
  });
}

function handleRemindersPost(req, res) {
  readJsonBody(req, res, (data) => {
    const next = {};
    for (const raw of Array.isArray(data.items) ? data.items : []) {
      if (!raw || typeof raw !== 'object') { log('ERROR', '忽略了一条非法提醒（不是对象）'); continue; }
      let key = raw.key == null ? '' : String(raw.key);
      if (!key) key = raw.taskId == null ? '' : String(raw.taskId);
      if (!key) key = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const prev = rem.items[key];
      const item = normalizeReminder(Object.assign({}, raw, { key }), prev); // 整表替换，但沿用服务端维护的 firedAt/count
      if (!item) continue;
      if (prev && Number(item.at) > Number(prev.at) && rem.fired[key]) { // 前端把 at 往后改了 → 清 fired，让它重新生效
        delete rem.fired[key];
        firedInfo.delete(key);
        item.firedAt = null;
        item.count = 0;
      }
      next[key] = item;
    }
    rem.items = next; // fired 集合原样保留
    if (Number.isFinite(Number(data.catchupHours))) catchupHours = Number(data.catchupHours);
    saveReminders();
    const now = Date.now();
    let nextAt = null;
    for (const it of Object.values(rem.items)) {
      if (!rem.fired[it.key] && Number(it.at) > now && (nextAt === null || it.at < nextAt)) nextAt = it.at;
    }
    sendJson(res, 200, { ok: true, scheduled: Object.keys(rem.items).length, nextAt });
  });
}

function handleBackupGet(url, res) {
  const name = url.searchParams.get('name') || '';
  if (!name || name !== path.basename(name) || name.includes('/') || name.includes('\\')) return sendJson(res, 400, { ok: false, error: '非法的备份文件名' });
  const abs = path.resolve(BACKUP_DIR, name);
  if (!abs.startsWith(path.resolve(BACKUP_DIR) + path.sep)) return sendJson(res, 403, { ok: false, error: 'forbidden' }); // 只允许 basename
  fs.readFile(abs, (err, buf) => {
    if (err) return sendJson(res, 404, { ok: false, error: '备份不存在' });
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length }, CORS_HEADERS));
    res.end(buf);
  });
}

function handleBackupPost(req, res) {
  readJsonBody(req, res, (data) => {
    const name = makeBackup(Array.isArray(data.tasks) ? normalizeTasks(data.tasks) : state.tasks, true); // 手动备份不受节流限制
    if (!name) return sendJson(res, 500, { ok: false, error: '备份失败' });
    sendJson(res, 200, { ok: true, name });
  });
}

function handleQuit(req, res) {
  if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: '仅允许本机请求' });
  sendJson(res, 200, { ok: true });
  setTimeout(() => shutdown('收到 /api/quit'), 80); // 先让响应发出去
}

function route(req, res) {
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
  const p = url.pathname, m = req.method;
  if (m === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); return res.end(); } // CORS 预检
  if (p === '/api/ping' && m === 'GET') return sendJson(res, 200, pingPayload());
  if (p === '/api/state' && m === 'GET') return sendJson(res, 200, { ok: true, revision: state.revision, savedAt: state.savedAt, tasks: state.tasks });
  if (p === '/api/state' && m === 'POST') return handleStatePost(req, res);
  if (p === '/api/reminders' && m === 'POST') return handleRemindersPost(req, res);
  if (p === '/api/backups' && m === 'GET') return sendJson(res, 200, { ok: true, items: listBackups() });
  if (p === '/api/backup' && m === 'GET') return handleBackupGet(url, res);
  if (p === '/api/backup' && m === 'POST') return handleBackupPost(req, res);
  if (p === '/api/quit' && m === 'POST') return handleQuit(req, res);
  if (m === 'GET' || m === 'HEAD') return handleStatic(p, res);
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

function requestHandler(req, res) {
  try { route(req, res); }
  catch (e) { // 任何意外都不能让进程崩
    log('ERROR', `处理请求出错：${e && e.stack ? e.stack : e}`);
    try { sendJson(res, 500, { ok: false, error: 'internal error' }); } catch (_) { /* 响应可能已发出 */ }
  }
}
/* ========================= 端口与生命周期 ========================= */
let currentPort = 0, server = null, tickTimer = null;

function pingPort(port) { // 启动前探测该端口上是不是「今日事」自己
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 600 }, (r) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { data += c; });
      r.on('end', () => { try { const j = JSON.parse(data); resolve(j && j.name === SERVER_NAME ? j : null); } catch (_) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function tryListen(port) {
  return new Promise((resolve) => {
    const s = http.createServer(requestHandler);
    let settled = false;
    s.on('error', (e) => {
      if (settled) return;
      settled = true;
      log('INFO', `端口 ${port} 不可用（${e.code || e.message}），尝试下一个端口`);
      resolve(null);
    });
    s.once('listening', () => { if (settled) return; settled = true; resolve(s); });
    s.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  for (let p = opts.port; p <= opts.port + PORT_TRIES; p++) {
    if (await pingPort(p)) { console.log(`今日事后台服务已在运行（端口 ${p}）`); process.exit(0); } // 绝不重复启动
    const s = await tryListen(p);
    if (s) return { port: p, server: s };
  }
  console.error(`端口 ${opts.port}-${opts.port + PORT_TRIES} 全部被占用，无法启动`);
  process.exit(2);
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (tickTimer) clearInterval(tickTimer); } catch (_) { /* 忽略 */ }
  try { saveReminders(); } catch (_) { /* 忽略 */ }
  try { makeBackup(state.tasks, true); } catch (_) { /* 忽略 */ } // 退出时强制存一份
  log('INFO', `已停止（${reason}）`);
  try { if (server) server.close(); } catch (_) { /* 忽略 */ }
  process.exit(0);
}
/* ============================ 开机自启 ============================ */
function runPowerShellSync(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf8' });
}

function installAutostart() {
  const parts = [`"${process.execPath}"`, `"${SERVER_FILE}"`, `--port=${opts.port}`];
  if (opts.dataDir) parts.push(`--data-dir="${DATA_DIR}"`);
  if (opts.backupDir) parts.push(`--backup-dir="${BACKUP_DIR}"`);
  const script = `New-ItemProperty -Path '${RUN_KEY}' -Name '${RUN_NAME}' -Value '${parts.join(' ').replace(/'/g, "''")}' -PropertyType String -Force | Out-Null;`
    + ` Write-Output '已安装开机自启：${RUN_NAME}'`;
  try { console.log(String(runPowerShellSync(script)).trim()); }
  catch (e) { console.error('安装开机自启失败：' + (e && e.message ? e.message : e)); process.exit(1); }
}

function removeAutostart() {
  const script = `Remove-ItemProperty -Path '${RUN_KEY}' -Name '${RUN_NAME}' -ErrorAction SilentlyContinue;`
    + ` Write-Output '已取消开机自启：${RUN_NAME}'`;
  try { console.log(String(runPowerShellSync(script)).trim()); }
  catch (e) { console.error('取消开机自启失败：' + (e && e.message ? e.message : e)); process.exit(1); }
}
/* ============================== 启动 ============================== */
process.on('uncaughtException', (e) => log('ERROR', `未捕获异常：${e && e.stack ? e.stack : e}`));
process.on('unhandledRejection', (e) => log('ERROR', `未处理的 Promise 拒绝：${e && e.stack ? e.stack : e}`));

async function main() {
  if (opts.help) { console.log(USAGE); process.exit(0); }
  if (opts.install) { installAutostart(); process.exit(0); }
  if (opts.remove) { removeAutostart(); process.exit(0); }
  ensureDir(DATA_DIR);
  ensureDir(BACKUP_DIR);
  loadState();
  loadReminders();

  const picked = await pickPort();
  currentPort = picked.port;
  server = picked.server;
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log('INFO', `服务已启动：http://127.0.0.1:${currentPort}/（pid=${process.pid}，dryRun=${opts.dryRun}）`);
  catchupOnStartup();
  makeBackup(state.tasks, true); // 启动时强制存一份
  tickTimer = setInterval(tick, 1000);
  if (tickTimer.unref) tickTimer.unref();

  console.log('');
  console.log('  今日事 · 后台服务已启动');
  console.log(`  访问地址：http://127.0.0.1:${currentPort}/`);
  console.log(`  数据目录：${DATA_DIR}`);
  console.log(`  备份目录：${BACKUP_DIR}`);
  if (opts.dryRun) console.log('  运行模式：--dry-run（只记录通知，不真正弹窗）');
  console.log('  按 Ctrl+C 停止');
  console.log('');
}

main();
