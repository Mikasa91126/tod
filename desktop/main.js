/* ═══════════════════════════════════════════════════════════════
   今日事 · Electron 主进程
   职责：主窗口 / 系统托盘 / 提醒调度 / 系统通知 / 置顶弹窗 /
        任务镜像与合并 / 自动备份 / 数据迁移 / 开机自启
   与旧版 server.js 的关系：调度与备份逻辑 1:1 移植，
   HTTP API 改为 IPC（语义不变），数据仍落在 ../data ../backups
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeImage, powerSaveBlocker } = require('electron');
const fs = require('fs');
const path = require('path');

/* GPU 合成全开：玻璃层（backdrop-filter）的模糊走显卡光栅化，滚动/动画不掉帧 */
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

/* ──────────────────── 常量（与 server.js 对齐） ──────────────────── */
const SERVER_NAME = 'today-desktop';
const VERSION = 2;                       // v2 = Electron 桌面版
const APP_ROOT = path.join(__dirname, '..');          // tod 目录
const DATA_DIR = path.join(APP_ROOT, 'data');
const BACKUP_DIR = path.join(APP_ROOT, 'backups');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.json');
const LOG_FILE = path.join(DATA_DIR, 'desktop.log');
const NOTIFY_ERR_LOG = path.join(DATA_DIR, 'notify-error.log');
const ICON_FILE = path.join(APP_ROOT, 'app.ico');

const CATCHUP_HOURS_DEFAULT = 12;        // 补提醒时间窗
const FIRED_KEEP_MS = 24 * 3600 * 1000;  // fired 记录保留时长
const RERING_INTERVAL_MS = 5 * 60 * 1000;// 重要提醒重响间隔
const RERING_MAX = 6;                    // 重要提醒最多重响次数
const BACKUP_THROTTLE_MS = 5 * 60 * 1000;// 自动备份节流
const BACKUP_KEEP = 50;                  // 备份保留份数
const LOG_MAX_BYTES = 1024 * 1024;       // 日志轮转阈值
const TEXT_MAX = 120;                    // 通知正文截断长度
const RECENT_FIRED_MAX = 50;
const RECENT_FIRED_WINDOW_MS = 12 * 3600 * 1000;
const STATE_SAVE_DEBOUNCE_MS = 800;      // 任务镜像落盘防抖

/* ──────────────────── 小工具 ──────────────────── */
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function backupStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}
function truncate(s, n = TEXT_MAX) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { if (e.code !== 'EEXIST') log('ERROR', `创建目录失败 ${dir}：${e.message}`); }
}
function writeFileAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}
function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function log(level, msg) {
  try {
    ensureDir(DATA_DIR);
    let line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    try { const st = fs.statSync(LOG_FILE); if (st.size > LOG_MAX_BYTES) fs.writeFileSync(LOG_FILE, ''); } catch (_) { }
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (_) { }
}
function logNotifyError(msg) {
  try { fs.appendFileSync(NOTIFY_ERR_LOG, `[${new Date().toISOString()}] [ERROR] ${msg}\n`, 'utf8'); } catch (_) { }
}

/* ──────────────────── 任务镜像与合并（语义同 server.js） ──────────────────── */
function hash32(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id == null || raw.id === '' ? hash32(String(raw.text || '') + String(raw.createdAt || '')) + Date.now().toString(36) : String(raw.id);
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const remindBeforeList = Array.isArray(raw.remindBeforeList)
    ? raw.remindBeforeList.map(Number).filter(Number.isFinite).filter(v => v >= 0)
    : (Number.isFinite(Number(raw.remindBefore)) && Number(raw.remindBefore) > 0 ? [Number(raw.remindBefore)] : []);
  const remindBefore = remindBeforeList.length ? remindBeforeList[0] : 0;
  return {
    id,
    text: raw.text == null ? '' : String(raw.text).slice(0, 500),
    notes: raw.notes == null ? '' : String(raw.notes).slice(0, 5000),
    done: !!raw.done,
    deleted: !!raw.deleted,
    createdAt: num(raw.createdAt, Date.now()),
    updatedAt: num(raw.updatedAt, Date.now()),
    completedAt: raw.completedAt == null ? null : num(raw.completedAt, null),
    dueDate: raw.dueDate == null ? null : String(raw.dueDate),
    dueTime: raw.dueTime == null ? null : String(raw.dueTime),
    priority: ['high', 'medium', 'low', 'none'].includes(raw.priority) ? raw.priority : 'none',
    category: raw.category == null ? null : String(raw.category),
    subtasks: Array.isArray(raw.subtasks) ? raw.subtasks.slice(0, 50) : [],
    remindAt: raw.remindAt == null ? null : num(raw.remindAt, null),
    remindBefore,
    remindBeforeList,
    remindPersist: !!raw.remindPersist,
    snoozedUntil: raw.snoozedUntil == null ? null : num(raw.snoozedUntil, null),
    remindOff: !!raw.remindOff,
    repeat: raw.repeat == null ? null : String(raw.repeat),
    deletedAt: raw.deletedAt == null ? null : num(raw.deletedAt, null),
  };
}
function normalizeTasks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list.slice(0, 2000)) { const n = normalizeTask(t); if (n) out.push(n); }
  return out;
}
/** 合并：按 id 并集，updatedAt 新者胜，顺序以提交方为准，服务端独有追加在后 */
function mergeTasks(submitted, disk) {
  const diskMap = new Map(disk.map((t) => [t.id, t]));
  const out = [];
  const seen = new Set();
  for (const t of submitted) {
    const prev = diskMap.get(t.id);
    out.push(!prev || t.updatedAt >= prev.updatedAt ? t : prev);
    seen.add(t.id);
  }
  for (const t of disk) if (!seen.has(t.id)) out.push(t);
  return out;
}

const state = { revision: 0, savedAt: null, tasks: [], dirty: false, saveTimer: null };

function loadState() {
  const raw = readJsonFile(TASKS_FILE);
  if (raw && typeof raw === 'object') {
    state.tasks = normalizeTasks(raw.tasks);
    state.revision = Number(raw.revision) || 0;
    state.savedAt = Number.isFinite(Number(raw.savedAt)) ? Number(raw.savedAt) : null;
  }
  log('INFO', `已载入任务镜像 ${state.tasks.length} 条（revision=${state.revision}）`);
}
function saveStateNow() {
  try {
    ensureDir(DATA_DIR);
    writeFileAtomic(TASKS_FILE, JSON.stringify({ revision: state.revision, savedAt: state.savedAt, tasks: state.tasks }, null, 2));
    state.dirty = false;
  } catch (e) { log('ERROR', `保存 tasks.json 失败：${e.message}`); }
}
function scheduleStateSave() {
  state.dirty = true;
  if (state.saveTimer) return;
  state.saveTimer = setTimeout(() => { state.saveTimer = null; saveStateNow(); }, STATE_SAVE_DEBOUNCE_MS);
}

/* ──────────────────── 备份（语义同 server.js） ──────────────────── */
let lastBackupAt = 0;
function pruneBackups() {
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR); } catch (_) { return; }
  const files = names.filter((n) => /^todo-\d{8}-\d{6}\.json$/.test(n)).sort();
  for (const n of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, n)); } catch (_) { }
  }
}
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
    try { const st = fs.statSync(path.join(BACKUP_DIR, n)); items.push({ name: n, size: st.size, savedAt: Math.round(st.mtimeMs) }); } catch (_) { }
  }
  items.sort((a, b) => b.savedAt - a.savedAt);
  return items.slice(0, BACKUP_KEEP);
}
function readBackupFile(name) {
  if (!name || name !== path.basename(name) || name.includes('/') || name.includes('\\')) return null;
  const abs = path.resolve(BACKUP_DIR, name);
  if (!abs.startsWith(path.resolve(BACKUP_DIR) + path.sep)) return null;
  const raw = readJsonFile(abs);
  return Array.isArray(raw) ? raw : null;
}

/* ──────────────────── 提醒调度（语义同 server.js） ──────────────────── */
const rem = { items: {}, fired: {} };
const firedInfo = new Map();
let catchupHours = CATCHUP_HOURS_DEFAULT;
let pausedUntil = 0; // 「暂停提醒」截止时刻；期间到点的提醒不弹、不标记，恢复后照常响
let remindersSaveTimer = null;

function normalizeReminder(raw, prev) {
  if (!raw || typeof raw !== 'object') return null;
  const taskId = raw.taskId == null ? '' : String(raw.taskId);
  let key = raw.key == null ? '' : String(raw.key);
  if (!key) key = taskId ? `${taskId}@${Number(raw.at) || 0}` : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const at = Number(raw.at), rawFired = Number(raw.firedAt);
  return {
    key, taskId, text: raw.text == null ? '' : String(raw.text), persist: !!raw.persist,
    at: Number.isFinite(at) ? at : Date.now(),
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
  for (const [k, it] of Object.entries(rem.items)) if (rem.fired[k]) firedInfo.set(k, { taskId: it.taskId, text: it.text, at: it.at });
  pruneFired();
  log('INFO', `已载入提醒 ${Object.keys(rem.items).length} 条（已触发 ${Object.keys(rem.fired).length} 条）`);
}
function pruneFired() {
  const now = Date.now();
  for (const [k, ts] of Object.entries(rem.fired)) if (!Number.isFinite(ts) || now - ts > FIRED_KEEP_MS) { delete rem.fired[k]; firedInfo.delete(k); }
}
function saveReminders() {
  pruneFired();
  try {
    ensureDir(DATA_DIR);
    writeFileAtomic(REMINDERS_FILE, JSON.stringify({ items: rem.items, fired: rem.fired, updatedAt: Date.now() }, null, 2));
  } catch (e) { log('ERROR', `保存 reminders.json 失败：${e.message}`); }
}
function scheduleRemindersSave() {
  if (remindersSaveTimer) return;
  remindersSaveTimer = setTimeout(() => { remindersSaveTimer = null; saveReminders(); }, 1000);
}
function recentFired() {
  const now = Date.now(), out = [];
  for (const [key, ts] of Object.entries(rem.fired)) {
    if (!Number.isFinite(ts) || now - ts > RECENT_FIRED_WINDOW_MS) continue;
    const info = firedInfo.get(key) || rem.items[key] || {};
    out.push({ key, taskId: info.taskId == null ? '' : String(info.taskId), text: info.text == null ? '' : String(info.text), at: Number(info.at) || ts, _ts: ts });
  }
  out.sort((a, b) => b._ts - a._ts);
  return out.slice(0, RECENT_FIRED_MAX).map((x) => ({ key: x.key, taskId: x.taskId, text: x.text, at: x.at }));
}
function markFired(item, now, firstTime) {
  if (firstTime) { rem.fired[item.key] = now; firedInfo.set(item.key, { taskId: item.taskId, text: item.text, at: item.at }); }
  item.firedAt = now;
  item.count = (Number(item.count) || (firstTime ? 0 : 1)) + 1;
}

/* ──────────────────── 系统通知（Electron 原生，可点击） ──────────────────── */
function notify(title, body, timeText, taskId) {
  const text = truncate(body);
  log('INFO', `发送通知：${title} | ${text}`);
  if (!Notification.isSupported()) { logNotifyError('当前系统不支持通知'); return; }
  const n = new Notification({
    title,
    body: timeText ? `${text}\n${timeText}` : text,
    icon: ICON_FILE,
    silent: false,
    urgency: 'critical',
    timeoutType: 'never',
  });
  n.on('click', () => {
    showMainWindow();
    if (taskId && taskId !== '__focus__') sendToRenderer('reminder:focus-task', { taskId });
  });
  n.on('failed', (e) => logNotifyError(`通知失败：${e}`));
  try { n.show(); } catch (e) { logNotifyError(`通知异常：${e.message}`); }
}
function notifyReminder(item, isRering) {
  notify('今日事', (isRering ? '[未处理] ' : '') + truncate(item.text || '（无内容）'), fmtTime(item.at || Date.now()), item.taskId);
}

/* ──────────────────── 置顶弹窗（不受勿扰模式影响） ──────────────────── */
let popupWin = null;
function showReminderPopup(item) {
  try {
    if (popupWin && !popupWin.isDestroyed()) { popupWin.close(); popupWin = null; }
    popupWin = new BrowserWindow({
      width: 400, height: 260,
      x: popupPosition().x, y: popupPosition().y,
      frame: false, resizable: false, movable: true,
      alwaysOnTop: true, skipTaskbar: true, minimizable: false, maximizable: false,
      show: false, backgroundColor: '#00000000',
      icon: ICON_FILE,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, additionalArguments: ['--popup-mode'] },
    });
    popupWin.setAlwaysOnTop(true, 'screen-saver'); // 置顶层级拉满，盖住全屏应用
    const q = `?key=${encodeURIComponent(item.key)}&taskId=${encodeURIComponent(item.taskId || '')}&text=${encodeURIComponent(truncate(item.text || '（无内容）', 200))}&at=${encodeURIComponent(fmtTime(item.at || Date.now()))}&persist=${item.persist ? 1 : 0}`;
    popupWin.loadFile(path.join(__dirname, 'popup.html'), { search: q });
    popupWin.once('ready-to-show', () => { popupWin.show(); popupWin.focus(); });
    popupWin.on('closed', () => { popupWin = null; });
    log('INFO', `已弹出置顶提醒窗：${truncate(item.text || '', 30)}`);
  } catch (e) { log('ERROR', `置顶弹窗失败：${e.message}`); }
}
function popupPosition() {
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 400, h = 260, margin = 16;
  return { x: wa.x + wa.width - w - margin, y: wa.y + wa.height - h - margin };
}

/* ──────────────────── 调度核心（语义同 server.js tick） ──────────────────── */
let winRef = null; // 主窗口引用，由 createWindow 赋值

function sendToRenderer(channel, payload) {
  try {
    if (winRef && !winRef.isDestroyed() && !winRef.webContents.isDestroyed()) {
      winRef.webContents.send(channel, payload);
    }
  } catch (_) { }
}
/** 窗口是否「正被看着」：可见、未最小化、未失焦隐藏 */
function windowVisibleForAlarm() {
  return !!(winRef && !winRef.isDestroyed() && winRef.isVisible() && !winRef.isMinimized());
}

function tick() {
  const now = Date.now();
  if (now < pausedUntil) return; // 暂停中：不弹不标记，恢复后照常触发
  let dirty = false;
  for (const item of Object.values(rem.items)) {
    const firstFired = rem.fired[item.key];
    if (!firstFired) {
      if (Number(item.at) <= now) {
        fireReminder(item, false);
        markFired(item, now, true);
        dirty = true;
      }
      continue;
    }
    if (!item.persist) continue;
    const last = Number(item.firedAt) || firstFired;
    if (Math.max(0, (Number(item.count) || 1) - 1) < RERING_MAX && now - last >= RERING_INTERVAL_MS) {
      notifyReminder(item, true);
      markFired(item, now, false);
      dirty = true;
    }
  }
  if (dirty) scheduleRemindersSave();
}

/** 到点提醒的双保险：系统通知 +（窗口不可见时）置顶弹窗；窗口可见时交给页内闹钟 */
function fireReminder(item, isRering) {
  notifyReminder(item, isRering);
  if (windowVisibleForAlarm()) {
    sendToRenderer('reminder:fired', { key: item.key, taskId: item.taskId, text: item.text, at: item.at, persist: item.persist });
  } else {
    showReminderPopup(item);
  }
}

/** 启动补提醒：窗口内合并成一条补发；窗口外静默作废 */
function catchupOnStartup() {
  const now = Date.now(), winStart = now - catchupHours * 3600 * 1000;
  const missed = [], silent = [];
  for (const item of Object.values(rem.items)) {
    if (rem.fired[item.key] || Number(item.at) > now) continue;
    (Number(item.at) < winStart ? silent : missed).push(item);
  }
  if (missed.length) {
    const names = missed.slice(0, 3).map((it) => truncate(it.text || '（无内容）', 20)).join('、');
    notify('今日事', `错过 ${missed.length} 条提醒：${names}${missed.length > 3 ? ` 等 ${missed.length} 条` : ''}`, fmtTime(now), null);
  }
  for (const item of missed.concat(silent)) markFired(item, now, true);
  if (missed.length || silent.length) log('INFO', `补提醒：补发 ${missed.length} 条，静默作废 ${silent.length} 条`);
  saveReminders();
}

/* ──────────────────── 窗口状态持久化 ──────────────────── */
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadWindowState() {
  const raw = readJsonFile(stateFile()) || {};
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Number.isFinite(raw.width) ? raw.width : 1120;
  const h = Number.isFinite(raw.height) ? raw.height : 720;
  let x = Number.isFinite(raw.x) ? raw.x : undefined;
  let y = Number.isFinite(raw.y) ? raw.y : undefined;
  if (x !== undefined && (x < wa.x - 40 || x > wa.x + wa.width - 80)) x = undefined;
  if (y !== undefined && (y < wa.y - 40 || y > wa.y + wa.height - 80)) y = undefined;
  return { width: Math.min(w, wa.width), height: Math.min(h, wa.height), x, y, maximized: !!raw.maximized };
}
let saveStateTimer = null;
function scheduleWindowStateSave() {
  if (saveStateTimer) return;
  saveStateTimer = setTimeout(() => {
    saveStateTimer = null;
    try {
      if (!winRef || winRef.isDestroyed()) return;
      const b = winRef.getNormalBounds();
      writeFileAtomic(stateFile(), JSON.stringify({ width: b.width, height: b.height, x: b.x, y: b.y, maximized: winRef.isMaximized() }));
    } catch (_) { }
  }, 600);
}

/* ──────────────────── 托盘 ──────────────────── */
let tray = null;
let closeToTray = true;
let trayNoticeShown = false;

function trayIcon() {
  try { return nativeImage.createFromPath(ICON_FILE); } catch (_) { return undefined; }
}
function createTray() {
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('今日事');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { label: '快速添加任务', click: () => { showMainWindow(); sendToRenderer('tray:quick-add', {}); } },
      { type: 'separator' },
      { label: '暂停提醒 1 小时', click: () => { sendToRenderer('tray:pause-reminders', { minutes: 60 }); showMainWindow(); } },
      { type: 'separator' },
      { label: '退出', click: () => { app.quitting = true; app.quit(); } },
    ]));
    tray.on('click', () => showMainWindow());
    log('INFO', '托盘已创建');
  } catch (e) { log('ERROR', `托盘创建失败：${e.message}`); }
}

function showMainWindow() {
  if (!winRef || winRef.isDestroyed()) { createMainWindow(); return; }
  if (winRef.isMinimized()) winRef.restore();
  winRef.show();
  winRef.focus();
}

/* ──────────────────── 主窗口 ──────────────────── */
function createMainWindow() {
  const ws = loadWindowState();
  winRef = new BrowserWindow({
    width: ws.width, height: ws.height,
    x: ws.x, y: ws.y,
    minWidth: 760, minHeight: 520,
    show: false,
    backgroundColor: '#f4f5f7',
    icon: ICON_FILE,
    autoHideMenuBar: true,
    title: '今日事',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,   // 窗口失焦/最小化时提醒调度不受节流
    },
  });
  Menu.setApplicationMenu(null);
  if (ws.maximized) winRef.maximize();

  winRef.loadFile(path.join(__dirname, 'index.html'));
  winRef.once('ready-to-show', () => {
    winRef.show();
    if (process.argv.includes('--smoke')) runSmoke();
  });

  // 无菜单栏窗口提供刷新途径：Ctrl+R / F5 重载页面
  winRef.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const isReload = input.key === 'F5' || ((input.control || input.metaKey) && input.key.toLowerCase() === 'r');
    if (isReload) { winRef.webContents.reload(); e.preventDefault(); }
  });

  // 渲染层报错回传到日志（冒烟与排错用）；过滤 Electron 开发期安全提示噪音
  winRef.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (message && message.includes('Electron Security Warning')) return;
    if (level >= 2) log(level >= 3 ? 'ERROR' : 'WARN', `渲染层[${level}]: ${message} @${sourceId}:${line}`);
  });
  winRef.webContents.on('render-process-gone', (_e, details) => log('ERROR', `渲染进程退出：${details.reason}`));
  winRef.on('resize', scheduleWindowStateSave);
  winRef.on('move', scheduleWindowStateSave);
  winRef.on('maximize', scheduleWindowStateSave);
  winRef.on('unmaximize', scheduleWindowStateSave);

  // 关闭 → 最小化到托盘（退出走 app.quitting）
  winRef.on('close', (e) => {
    if (app.quitting || !closeToTray) return;
    e.preventDefault();
    winRef.hide();
    if (!trayNoticeShown) {
      trayNoticeShown = true;
      try {
        const n = new Notification({ title: '今日事仍在运行', body: '已最小化到托盘，到点仍会提醒。右键托盘图标可退出。', icon: ICON_FILE, silent: true });
        n.on('click', () => showMainWindow());
        n.show();
      } catch (_) { }
    }
  });
  winRef.on('closed', () => { winRef = null; });
  log('INFO', '主窗口已创建');
}

/* ──────────────────── IPC API（语义与旧 HTTP API 对齐） ──────────────────── */
function registerIpc() {
  ipcMain.handle('api:ping', () => ({
    ok: true, name: SERVER_NAME, version: VERSION, pid: process.pid,
    now: Date.now(), recentFired: recentFired(),
    features: { popup: true, tray: true, multiRemind: true },
  }));

  ipcMain.handle('api:state:pull', () => ({
    ok: true, revision: state.revision, savedAt: state.savedAt,
    tasks: state.tasks, recentFired: recentFired(),
  }));

  ipcMain.handle('api:state:push', (e, data) => {
    const submitted = normalizeTasks(data && data.tasks);
    state.tasks = mergeTasks(submitted, state.tasks);
    state.revision = Math.max(Number(state.revision) || 0, Number(data && data.revision) || 0) + 1;
    state.savedAt = Date.now();
    scheduleStateSave();
    makeBackup(state.tasks, false);
    return { ok: true, revision: state.revision, savedAt: state.savedAt, tasks: state.tasks };
  });

  ipcMain.handle('api:reminders:sync', (e, data) => {
    const next = {};
    for (const raw of Array.isArray(data && data.items) ? data.items : []) {
      if (!raw || typeof raw !== 'object') { log('ERROR', '忽略了一条非法提醒'); continue; }
      let key = raw.key == null ? '' : String(raw.key);
      if (!key) key = raw.taskId == null ? '' : String(raw.taskId);
      if (!key) key = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const prev = rem.items[key];
      const item = normalizeReminder(Object.assign({}, raw, { key }), prev);
      if (!item) continue;
      if (prev && Number(item.at) > Number(prev.at) && rem.fired[key]) {
        delete rem.fired[key];
        firedInfo.delete(key);
        item.firedAt = null;
        item.count = 0;
      }
      next[key] = item;
    }
    rem.items = next;
    if (data && Number.isFinite(Number(data.catchupHours))) catchupHours = Number(data.catchupHours);
    if (data && Number.isFinite(Number(data.pausedUntil))) pausedUntil = Number(data.pausedUntil);
    saveReminders();
    const now = Date.now();
    let nextAt = null;
    for (const it of Object.values(rem.items)) {
      if (!rem.fired[it.key] && Number(it.at) > now && (nextAt === null || it.at < nextAt)) nextAt = it.at;
    }
    return { ok: true, scheduled: Object.keys(rem.items).length, nextAt };
  });

  ipcMain.handle('api:backup:create', (e, data) => {
    const name = makeBackup(normalizeTasks(data && data.tasks), true); // 手动备份不受节流
    return { ok: !!name, name };
  });
  ipcMain.handle('api:backups:list', () => ({ ok: true, items: listBackups() }));
  ipcMain.handle('api:backup:read', (e, name) => {
    const tasks = readBackupFile(name);
    return tasks ? { ok: true, tasks } : { ok: false, error: '备份不存在' };
  });

  ipcMain.handle('app:window', (e, action) => {
    if (action === 'hide' && winRef) winRef.hide();
    else if (action === 'show') showMainWindow();
    else if (action === 'minimize' && winRef) winRef.minimize();
    return true;
  });
  ipcMain.handle('app:get-env', () => ({
    ok: true, closeToTray, autostart: app.getLoginItemSettings().openAtLogin,
    dataDir: DATA_DIR, backupDir: BACKUP_DIR,
  }));
  ipcMain.handle('app:set-close-to-tray', (e, v) => { closeToTray = !!v; savePrefs(); return closeToTray; });
  ipcMain.handle('app:set-autostart', (e, v) => {
    try { app.setLoginItemSettings({ openAtLogin: !!v, path: process.execPath, args: [__dirname] }); } catch (_) { }
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle('app:flash-window', (e, on) => { try { if (winRef && !winRef.isDestroyed()) winRef.flashFrame(!!on); } catch (_) { } return true; });
  ipcMain.handle('app:quit', () => { app.quitting = true; app.quit(); });
  ipcMain.handle('app:open-path', (e, p) => {
    if (typeof p !== 'string') return false;
    const abs = path.resolve(p);
    if (!abs.startsWith(APP_ROOT)) return false; // 只允许打开应用目录内的路径
    shell.openPath(abs);
    return true;
  });

  // 置顶弹窗上的按钮：转发给主窗口执行（主窗口是数据权威）
  ipcMain.on('popup:action', (e, payload) => {
    const { action, key, taskId } = payload || {};
    try { if (popupWin && !popupWin.isDestroyed()) popupWin.close(); } catch (_) { }
    sendToRenderer('reminder:popup-action', { action, key, taskId });
    log('INFO', `置顶弹窗操作：${action}（key=${key}）`);
  });
  ipcMain.on('popup:show-main', () => showMainWindow());
}

/* ──────────────────── 冒烟测试（--smoke：起真实窗口 → 页内探针 → 自动退出） ──────────────────── */
async function runSmoke() {
  try {
    await new Promise(res => setTimeout(res, 4000)); // 等待连接与首次推送
    const probe = await winRef.webContents.executeJavaScript(`(async () => {
      const T = window.__TODAY || {};
      const { Store, Companion, Reminders, Render, Query, Desktop, parseLocalDateTime } = T;
      if(!Store || !Companion) return { desktop: !!window.desktop, bridge: false };
      const t0 = Date.now();
      while(!Companion.alive && Date.now()-t0 < 9000) await new Promise(r=>setTimeout(r,200));
      const out = { desktop: !!window.desktop, bridge: true, alive: Companion.alive, taskCount: Store.tasks.length, revision: Companion.revision };
      // 多级提醒调度断言（真实调度代码）
      const base = parseLocalDateTime('2030-01-01','10:00');
      const t = { id:'test1', text:'x', done:false, deleted:false, dueDate:'2030-01-01', dueTime:'10:00',
                  remindAt:null, remindOff:false, remindBeforeList:[60,1440], snoozedUntil:null };
      const ats = Reminders.scheduleAts(t).sort((a,b)=>a-b);
      out.atsOk = JSON.stringify(ats) === JSON.stringify([base-1440*60000, base-60*60000, base]);
      out.computeAtOk = Reminders.computeAt(t) === base-1440*60000;
      // 回顾与渲染签名可用性
      const r = Query.review();
      out.reviewOk = typeof r.doneThisWeek === 'number' && typeof r.streak === 'number';
      out.sigOk = typeof Render._listSig === 'string';
      out.pausedOk = (function(){ Desktop.pauseReminders(60); const ok = Store.settings.pausedUntil > Date.now(); Store.settings.pausedUntil = 0; Store.saveAux(); return ok; })();
      return out;
    })()`, true);
    log('INFO', 'SMOKE ' + JSON.stringify(probe));
    app.quitting = true;
    const pass = probe.bridge && probe.desktop && probe.alive && probe.atsOk && probe.computeAtOk && probe.reviewOk && probe.sigOk && probe.pausedOk;
    app.exit(pass ? 0 : 3);
  } catch (e) {
    log('ERROR', 'SMOKE failed: ' + e.message);
    app.quitting = true;
    app.exit(3);
  }
}

/* ──────────────────── 应用生命周期 ──────────────────── */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    app.setAppUserModelId('com.today.todo.desktop');
    log('INFO', `今日事桌面版启动（v${VERSION}，electron ${process.versions.electron}）`);
    // 防止 Windows 省电模式把帧率压到 30fps / 挂起计时器（托盘常驻应用本就需要常活）
    try { powerSaveBlocker.start('prevent-app-suspension'); } catch (e) { log('WARN', `powerSaveBlocker 失败：${e.message}`); }
    loadState();
    loadReminders();
    loadPrefs();
    registerIpc();
    createMainWindow();
    createTray();
    setInterval(tick, 1000);
    catchupOnStartup();
    setInterval(() => { if (state.dirty) saveStateNow(); }, 60 * 1000); // 兜底：脏状态每分钟落盘
  });

  app.on('window-all-closed', () => { /* 托盘常驻：不退出 */ });
  app.on('before-quit', () => {
    app.quitting = true;
    saveStateNow();
    saveReminders();
    log('INFO', '已退出（数据与提醒已落盘）');
  });
}

/* ──────────────────── 用户偏好（托盘/关闭行为等主进程侧设置） ──────────────────── */
function prefsFile() { return path.join(app.getPath('userData'), 'prefs.json'); }
function loadPrefs() {
  const raw = readJsonFile(prefsFile()) || {};
  if (typeof raw.closeToTray === 'boolean') closeToTray = raw.closeToTray;
}
function savePrefs() {
  try { writeFileAtomic(prefsFile(), JSON.stringify({ closeToTray })); } catch (_) { }
}

/* ──────────────────── 单测钩子（test/merge.test.mjs 通过 electron 桩 + TODAY_TEST=1 引入纯函数） ──────────────────── */
if (process.env.TODAY_TEST === '1') {
  module.exports = { normalizeTask, normalizeTasks, mergeTasks, normalizeReminder };
}
