/* 合并与归一化逻辑单测：用 electron 桩预占 require 缓存，再引入 main.js 的纯函数 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

/* ── electron 桩：只覆盖 main.js 顶层用到的 API，whenReady 永不 resolve → 无副作用 ── */
const stub = {
  app: {
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}),
    on: () => {},
    setAppUserModelId: () => {},
    quit: () => {},
    getPath: () => os.tmpdir(),
    setLoginItemSettings: () => {},
    getLoginItemSettings: () => ({ openAtLogin: false }),
  },
  BrowserWindow: class {},
  Tray: class {},
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => [] },
  Notification: class { static isSupported() { return true; } on() {} show() {} },
  ipcMain: { handle: () => {}, on: () => {} },
  nativeImage: { createFromPath: () => ({}) },
  shell: { openPath: async () => '' },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
};
const electronId = require.resolve('electron', { paths: [DESKTOP] });
require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: stub };

process.env.TODAY_TEST = '1';
const main = require(path.join(DESKTOP, 'main.js'));

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('✅ ' + name); }
  catch (e) { console.error('❌ ' + name + '：' + e.message); process.exitCode = 1; }
}

/* ── normalizeTask ── */
t('归一化：缺省字段兜底', () => {
  const n = main.normalizeTask({ id: 'a', text: 'hello' });
  assert.equal(n.done, false);
  assert.equal(n.priority, 'none');
  assert.ok(Number.isFinite(n.createdAt));
  assert.deepEqual(n.remindBeforeList, []);
});
t('归一化：旧 remindBefore 升级为列表', () => {
  const n = main.normalizeTask({ id: 'a', text: 'x', remindBefore: 15 });
  assert.deepEqual(n.remindBeforeList, [15]);
  assert.equal(n.remindBefore, 15);
});
t('归一化：remindBeforeList 保留并过滤非法值', () => {
  const n = main.normalizeTask({ id: 'a', text: 'x', remindBeforeList: [5, 'x', -3, 60], remindBefore: 99 });
  assert.deepEqual(n.remindBeforeList, [5, 60]);
  assert.equal(n.remindBefore, 5);
});
t('归一化：非法优先级回落 none', () => {
  const n = main.normalizeTask({ id: 'a', text: 'x', priority: 'urgent' });
  assert.equal(n.priority, 'none');
});

/* ── mergeTasks：语义与旧版 server.js 一致 ── */
t('合并：同 id 取 updatedAt 更大者', () => {
  const disk = [main.normalizeTask({ id: 'a', text: '旧', updatedAt: 100 })];
  const sub = [main.normalizeTask({ id: 'a', text: '新', updatedAt: 200 })];
  assert.equal(main.mergeTasks(sub, disk)[0].text, '新');
});
t('合并：旧提交不能覆盖服务端较新版本', () => {
  const disk = [main.normalizeTask({ id: 'a', text: '服务端新', updatedAt: 300 })];
  const sub = [main.normalizeTask({ id: 'a', text: '提交旧', updatedAt: 100 })];
  assert.equal(main.mergeTasks(sub, disk)[0].text, '服务端新');
});
t('合并：服务端独有任务保留并追加在后', () => {
  const disk = [main.normalizeTask({ id: 'b', text: 'b', updatedAt: 1 })];
  const sub = [main.normalizeTask({ id: 'a', text: 'a', updatedAt: 1 })];
  const out = main.mergeTasks(sub, disk);
  assert.deepEqual(out.map(x => x.id), ['a', 'b']);
});
t('合并：顺序以提交方为准', () => {
  const disk = [main.normalizeTask({ id: 'a', text: 'a', updatedAt: 1 }), main.normalizeTask({ id: 'b', text: 'b', updatedAt: 1 })];
  const sub = [main.normalizeTask({ id: 'b', text: 'b', updatedAt: 1 }), main.normalizeTask({ id: 'a', text: 'a', updatedAt: 1 })];
  assert.deepEqual(main.mergeTasks(sub, disk).map(x => x.id), ['b', 'a']);
});
t('合并：空提交不丢服务端数据', () => {
  const disk = [main.normalizeTask({ id: 'a', text: 'a', updatedAt: 1 })];
  assert.equal(main.mergeTasks([], disk).length, 1);
});

/* ── normalizeReminder ── */
t('提醒归一化：沿用服务端维护的 firedAt/count', () => {
  const prev = { key: 'a@1', firedAt: 555, count: 3 };
  const n = main.normalizeReminder({ key: 'a@1', taskId: 'a', at: 1000 }, prev);
  assert.equal(n.firedAt, 555);
  assert.equal(n.count, 3);
});
t('提醒归一化：无 key 时按 taskId@at 兜底', () => {
  const n = main.normalizeReminder({ taskId: 'a', at: 42 }, null);
  assert.equal(n.key, 'a@42');
});

console.log(`\n合并逻辑单测：${passed} 项通过`);
if (process.exitCode) process.exit(process.exitCode);
