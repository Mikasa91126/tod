/* Electron 冒烟测试：启动真实应用（--smoke），等待页内探针结果，校验后自动退出 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const electronExe = require('electron'); // npm 包在 node 环境返回 electron.exe 路径

// 冒烟实例受单实例锁约束：先结束正在运行的应用实例，再记日志起点（避免把强杀产生的 crashed 记账到本次）
import { execSync } from 'node:child_process';
try { execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"'); } catch (_) { }
await new Promise(r => setTimeout(r, 1200));

const LOG = path.join(DESKTOP, '..', 'data', 'desktop.log');
const logSizeBefore = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;

console.log('启动 Electron 冒烟测试…');
const child = spawn(electronExe, ['.', '--smoke'], { cwd: DESKTOP, stdio: 'ignore' });
const timeout = setTimeout(() => {
  console.error('❌ 冒烟测试超时（30 秒未退出）');
  child.kill();
  process.exit(2);
}, 30000);

child.on('exit', (code) => {
  clearTimeout(timeout);
  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG).slice(logSizeBefore).toString('utf8') : '';
  const line = log.split('\n').find(l => l.includes('SMOKE {'));
  if (!line) {
    console.error('❌ 未找到 SMOKE 结果。日志：\n' + log.split('\n').slice(-15).join('\n'));
    process.exit(2);
  }
  const probe = JSON.parse(line.slice(line.indexOf('{')));
  const checks = [
    ['desktop 桥已暴露', probe.desktop],
    ['桌面服务已连接', probe.alive],
    ['多级提前量生成 3 条提醒', probe.atsOk],
    ['下一次提醒取最早一档', probe.computeAtOk],
    ['每周回顾数据可用', probe.reviewOk],
    ['渲染签名缓存生效', probe.sigOk],
    ['暂停提醒生效', probe.pausedOk],
  ];
  let fail = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? '✅ ' : '❌ ') + name);
    if (!ok) fail++;
  }
  console.log(`探针数据：taskCount=${probe.taskCount} revision=${probe.revision}`);
  const errors = log.split('\n').filter(l => l.includes('[ERROR]'));
  if (errors.length) {
    console.error('⚠️ 运行期错误：\n' + errors.slice(0, 10).join('\n'));
    fail++;
  }
  if (fail || code !== 0) { console.error(`❌ 冒烟测试未通过（exit=${code}，失败 ${fail} 项）`); process.exit(1); }
  console.log('\n冒烟测试全部通过 ✅');
});
