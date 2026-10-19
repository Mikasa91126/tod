/* ═══════════════════════════════════════════════════════════════
   preload：按窗口类型暴露最小安全的 IPC 桥
   - 主窗口  → window.desktop（与旧版 Companion 的 HTTP API 一一对应）
   - 置顶弹窗 → window.popupApi（仅按钮动作上报）
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ON_CHANNELS = [
  'reminder:fired',          // 主进程到点推送（窗口可见时）
  'reminder:popup-action',   // 置顶弹窗按钮动作转发
  'reminder:focus-task',     // 点击系统通知 → 聚焦某任务
  'tray:quick-add',          // 托盘「快速添加」
  'tray:pause-reminders',    // 托盘「暂停提醒」
];

if (process.argv.includes('--popup-mode')) {
  contextBridge.exposeInMainWorld('popupApi', {
    sendAction: (action, key, taskId) => ipcRenderer.send('popup:action', { action, key, taskId }),
    showMain: () => ipcRenderer.send('popup:show-main'),
  });
} else {
  const invoke = (ch, payload) => ipcRenderer.invoke(ch, payload);
  contextBridge.exposeInMainWorld('desktop', {
    // ── 与旧版 HTTP API 对齐 ──
    ping: () => invoke('api:ping'),
    pullState: () => invoke('api:state:pull'),
    pushState: (tasks, revision) => invoke('api:state:push', { tasks, revision }),
    syncReminders: (items, catchupHours, pausedUntil) => invoke('api:reminders:sync', { items, catchupHours, pausedUntil }),
    createBackup: (tasks) => invoke('api:backup:create', { tasks }),
    listBackups: () => invoke('api:backups:list'),
    readBackup: (name) => invoke('api:backup:read', name),
    // ── 桌面增强 ──
    window: (action) => invoke('app:window', action),
    getEnv: () => invoke('app:get-env'),
    setCloseToTray: (v) => invoke('app:set-close-to-tray', v),
    setAutostart: (v) => invoke('app:set-autostart', v),
    flashWindow: (on) => invoke('app:flash-window', on),
    quit: () => invoke('app:quit'),
    openPath: (p) => invoke('app:open-path', p),
    // ── 事件订阅 ──
    on: (channel, cb) => {
      if (!ON_CHANNELS.includes(channel)) return () => { };
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  });
}
