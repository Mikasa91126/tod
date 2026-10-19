#!/usr/bin/env node
/**
 * 今日事 · 自检脚本（verify.mjs）
 * ------------------------------------------------------------------
 * 只使用 Node 内置模块。跑法：node verify.mjs
 * 全部通过 → 打印「全部通过 ✅」；有失败 → process.exitCode = 1。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.js');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? ' — ' + detail : ''}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 稳定序列化：递归排序 key，便于做深比较 */
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const same = (a, b) => stable(a) === stable(b);

async function fetchJson(url, options = {}, timeoutMs = 5000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

function postJson(base, p, body) {
  return fetchJson(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function waitReady(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetchJson(base + '/api/ping', {}, 1500);
      if (r.json && r.json.name === 'today-server') return r.json;
    } catch (_) { /* 还没起来，继续轮询 */ }
    await sleep(200);
  }
  return null;
}

async function main() {
  // ---------- 端口选择：8799 空闲就用它，否则退到 8801 ----------
  let port = 8799;
  if (!(await portFree(port))) { port = 8801; console.log(`ℹ️  8799 被占用，改用 ${port}`); }
  if (!(await portFree(port))) { console.log(`❌ 端口 ${port} 也被占用，无法自检`); process.exitCode = 1; return; }
  const base = `http://127.0.0.1:${port}`;

  // ---------- 临时目录 ----------
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'today-verify-'));
  const dataDir = path.join(tmpRoot, 'data');
  const backupDir = path.join(tmpRoot, 'backups');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  console.log(`ℹ️  临时目录：${tmpRoot}`);

  let child = null;
  let exitInfo = null;
  let stdout = '';
  let stderr = '';
  try {
    // ---------- 1. 启动服务 ----------
    child = spawn(process.execPath, [
      SERVER, `--port=${port}`, '--dry-run', `--data-dir=${dataDir}`, `--backup-dir=${backupDir}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    // Windows 下必须消费管道，否则缓冲区满会卡死子进程
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    exitInfo = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

    // ---------- 2. 就绪探测 ----------
    const ping = await waitReady(base, 10000);
    check('服务在 10 秒内就绪且 name=today-server', !!ping, ping ? '' : `未就绪；stdout=${stdout.slice(-300)} stderr=${stderr.slice(-300)}`);
    if (!ping) throw new Error('服务未就绪，后续步骤跳过');
    check('ping.dryRun === true', ping.dryRun === true, String(ping.dryRun));
    check('ping.port 等于实际端口', ping.port === port, `${ping.port} vs ${port}`);
    check('ping.recentFired 是数组', Array.isArray(ping.recentFired));

    // ---------- 2.5 静态文件 / CORS / 目录穿越 ----------
    const root = await fetch(base + '/');
    const rootText = await root.text();
    check('GET / 返回 index.html（200 + text/html）', root.status === 200 && root.headers.get('content-type').startsWith('text/html') && rootText.includes('<'),
      `${root.status} ${root.headers.get('content-type')}`);
    check('静态响应带 CORS 头', root.headers.get('access-control-allow-origin') === '*' && root.headers.get('access-control-allow-headers') === 'Content-Type');
    const ico = await fetch(base + '/app.ico');
    check('GET /app.ico 返回图标', ico.status === 200 && ico.headers.get('content-type') === 'image/x-icon', `${ico.status} ${ico.headers.get('content-type')}`);
    const missing = await fetch(base + '/nope.js');
    check('其余路径 404', missing.status === 404, String(missing.status));
    const trav = await fetch(base + '/%2e%2e%2fserver.js');
    const travText = await trav.text();
    check('目录穿越被拒且不泄露源码', (trav.status === 404 || trav.status === 403) && !travText.includes('SERVER_NAME'), String(trav.status));
    const pre = await fetch(base + '/api/state', { method: 'OPTIONS' });
    check('OPTIONS 预检返回 204', pre.status === 204, String(pre.status));

    // ---------- 3. 状态往返 ----------
    const t0 = Date.now();
    const t1 = { id: 'a', text: '买牛奶', done: false, createdAt: t0, updatedAt: t0 };
    const t2 = { id: 'b', text: '写周报', done: false, createdAt: t0, updatedAt: t0 };
    const r3 = await postJson(base, '/api/state', { tasks: [t1, t2], revision: 0 });
    check('POST /api/state 返回 ok 且 revision 自增', r3.json && r3.json.ok === true && r3.json.revision >= 1, r3.text);
    const g3 = await fetchJson(base + '/api/state');
    check('GET /api/state 往返一致（2 条任务）', same(g3.json.tasks, [t1, t2]), JSON.stringify(g3.json.tasks));
    check('GET /api/state revision 与 POST 返回一致', g3.json.revision === r3.json.revision, `${g3.json.revision} vs ${r3.json.revision}`);

    // ---------- 4. 合并规则 ----------
    const t1new = { ...t1, text: '买牛奶（已改）', updatedAt: t0 + 1000 };
    const r4a = await postJson(base, '/api/state', { tasks: [t1new], revision: g3.json.revision });
    const a = r4a.json.tasks;
    check('合并：新者胜（同 id 取 updatedAt 更大）', a.length === 2 && a[0].id === 'a' && a[0].text === '买牛奶（已改）', JSON.stringify(a));
    check('合并：服务端独有任务保留并追加在后', a.length === 2 && a[1].id === 'b', JSON.stringify(a));
    check('合并：revision 继续递增', r4a.json.revision > g3.json.revision, `${r4a.json.revision} vs ${g3.json.revision}`);

    const t2old = { ...t2, text: '过期旧文本', updatedAt: t2.updatedAt - 10000 };
    const r4b = await postJson(base, '/api/state', { tasks: [t2old], revision: r4a.json.revision });
    const b = r4b.json.tasks;
    check('合并：旧提交不能覆盖服务端较新版本', b.length === 2 && b[0].id === 'b' && b[0].text === '写周报', JSON.stringify(b));
    check('合并：顺序以提交方为准（b 在前，a 追加在后）', b[1].id === 'a', JSON.stringify(b));

    const r4c = await postJson(base, '/api/state', { tasks: [{ id: 'c', text: '缺字段任务' }], revision: r4b.json.revision });
    const c = (r4c.json.tasks || []).find((x) => x.id === 'c');
    check('缺失字段兜底（不报错且补齐默认值）', !!c && c.done === false && Number.isFinite(c.updatedAt) && Number.isFinite(c.createdAt), JSON.stringify(c));

    // ---------- 5. 提醒触发 ----------
    const key = 'verify-' + Date.now();
    const at = Date.now() + 1500;
    const r5 = await postJson(base, '/api/reminders', { items: [{ key, taskId: 'a', text: '测试提醒', at, persist: false }], catchupHours: 12 });
    check('POST /api/reminders 返回 scheduled=1', r5.json && r5.json.ok === true && r5.json.scheduled === 1, r5.text);
    check('POST /api/reminders 返回 nextAt', r5.json && r5.json.nextAt === at, String(r5.json && r5.json.nextAt));

    await sleep(4000); // 等调度器触发 + 1 秒防抖落盘

    const ping2 = await fetchJson(base + '/api/ping');
    check('recentFired 里出现该 key', Array.isArray(ping2.json.recentFired) && ping2.json.recentFired.some((x) => x.key === key), JSON.stringify(ping2.json.recentFired));
    const remFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'reminders.json'), 'utf8'));
    check('reminders.json 的 fired 里有该 key', !!remFile.fired && Number.isFinite(remFile.fired[key]), JSON.stringify(remFile.fired));
    check('reminders.json 结构完整（items/fired/updatedAt）', !!remFile.items && !!remFile.fired && Number.isFinite(remFile.updatedAt));

    // ---------- 6. 备份 ----------
    const r6 = await postJson(base, '/api/backup', { tasks: [{ id: 'x', text: '备份用任务', done: false, createdAt: t0, updatedAt: t0 }] });
    check('POST /api/backup 返回 name', r6.json && r6.json.ok === true && typeof r6.json.name === 'string', r6.text);
    const backupPath = path.join(backupDir, r6.json.name || 'missing');
    check('备份文件已生成', fs.existsSync(backupPath), backupPath);
    check('备份内容为任务数组', (() => {
      try { return Array.isArray(JSON.parse(fs.readFileSync(backupPath, 'utf8'))); } catch (_) { return false; }
    })());
    const list = await fetchJson(base + '/api/backups');
    check('GET /api/backups 能列出该备份', Array.isArray(list.json.items) && list.json.items.some((i) => i.name === r6.json.name), list.text);
    const dl = await fetch(base + `/api/backup?name=${encodeURIComponent(r6.json.name)}`);
    check('GET /api/backup 返回原始 JSON', dl.status === 200 && dl.headers.get('content-type').startsWith('application/json') && Array.isArray(await dl.json()), String(dl.status));
    const bad = await fetch(base + '/api/backup?name=..%2F..%2Fserver.js');
    check('GET /api/backup 只允许 basename', bad.status === 400, String(bad.status));
    check('磁盘上生成了 tasks.json / reminders.json / server.log',
      ['tasks.json', 'reminders.json', 'server.log'].every((f) => fs.existsSync(path.join(dataDir, f))), fs.readdirSync(dataDir).join(','));

    // ---------- 7. 优雅退出 ----------
    const r7 = await postJson(base, '/api/quit', {});
    check('POST /api/quit 返回 ok', r7.json && r7.json.ok === true, r7.text);
    const exited = await Promise.race([exitInfo, sleep(3000).then(() => null)]);
    check('子进程 3 秒内以退出码 0 结束', !!exited && exited.code === 0, JSON.stringify(exited));
    child = null;
  } catch (e) {
    check('自检流程未抛异常', false, e && e.message ? e.message : String(e));
    if (stdout || stderr) console.log(`ℹ️  子进程输出：\n${stdout.slice(-1000)}\n${stderr.slice(-1000)}`);
  } finally {
    if (child && child.exitCode === null) { try { child.kill(); } catch (_) { /* 忽略 */ } }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* 清理失败不致命 */ }
  }

  // ---------- 8. 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.log(`❌ ${failed.length}/${results.length} 项未通过：${failed.map((f) => f.name).join('；')}`);
    process.exitCode = 1;
  } else {
    console.log(`全部通过 ✅（${results.length} 项）`);
  }
  process.exit(process.exitCode || 0); // 避免 keep-alive 连接让进程挂住
}

main();
