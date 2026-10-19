#!/usr/bin/env node
/**
 * 今日事（单文件网页待办应用）—— Edge 无头浏览器冒烟测试
 *
 * 用法：
 *   node smoke-test.mjs                     # 测同目录的 index.html
 *   node smoke-test.mjs --file <其它.html>  # 测任意版本
 *
 * 设计要点：
 *  1. 先把源 HTML 复制到系统临时目录再用 file:/// 打开副本，避免读到协作者正在写入的半截文件。
 *  2. 复制时注入两段探针（不修改源文件）：
 *     - 探针 A 插在 <head> 之后、应用脚本之前，捕获 window.onerror / error 事件 / unhandledrejection；
 *     - 探针 B 插在 </body> 之前，在初始化完成后记录 DOM 状态，并模拟点击「日历」「专注」标签。
 *     两者把结果 JSON 化写进 <div id="__smoke_report">，从 --dump-dom 的输出里读回来。
 *  3. --enable-logging=stderr --v=1 的日志作为补充手段一起收集。
 *
 * Edge 参数实测（Edge 153.0.4234.48）：`--headless=new` 与 `--headless` 均可用，
 * 默认用 `--headless=new`；若拿不到 DOM 输出则自动退回 `--headless`。
 *
 * 子进程输出用「文件描述符重定向」而不是管道：既能避开管道相关的沙箱限制，
 * 也能避免 --v=1 的大量日志把内存撑爆。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VIRTUAL_TIME_BUDGET = 5000;   // 毫秒：让页面里的定时器（setInterval 等）快速推进

// ── 命令行参数 ──────────────────────────────────────────────
function parseArgs(argv) {
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '-f') file = argv[++i];
    else if (a.startsWith('--file=')) file = a.slice('--file='.length);
  }
  return path.resolve(file || path.join(SCRIPT_DIR, 'index.html'));
}

// ── 同步睡眠（重试之间用，不需要 async）──────────────────────
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ── 探针 A：错误收集（必须早于应用脚本执行）─────────────────
const PROBE_A = `
<script>
(function(){
  var S = window.__smoke = { errors: [], checks: {} };
  var seen = {};
  function rec(msg, key){
    key = key || msg;
    if(seen[key]) return;
    seen[key] = 1;
    if(S.errors.length < 20) S.errors.push(String(msg).slice(0, 400));
  }
  // capture 阶段能同时拿到运行期错误与资源加载失败
  window.addEventListener('error', function(e){
    if(e && e.message){
      rec(e.message + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0) + ':' + (e.colno || 0),
          e.message + '@' + e.lineno + ':' + e.colno);
    } else if(e && e.target && e.target.tagName){
      rec('资源加载失败: <' + e.target.tagName.toLowerCase() + '> ' + (e.target.src || e.target.href || ''));
    }
  }, true);
  // 传统钩子，与上面的监听按 (message,line,col) 去重
  window.onerror = function(m, s, l, c){
    rec('window.onerror: ' + m + ' @ ' + s + ':' + l + ':' + c, m + '@' + l + ':' + c);
  };
  window.addEventListener('unhandledrejection', function(e){
    var r = e && e.reason;
    rec('未处理的 Promise 拒绝: ' + ((r && (r.message || r)) || r));
  });
  function flush(){
    try{
      var d = document.getElementById('__smoke_report');
      if(!d){
        d = document.createElement('div');
        d.id = '__smoke_report';
        d.hidden = true;
        (document.body || document.documentElement).appendChild(d);
      }
      d.textContent = JSON.stringify(S);
    }catch(e){}
  }
  window.__smokeFlush = flush;
  document.addEventListener('DOMContentLoaded', flush);
  window.addEventListener('load', flush);
  setInterval(flush, 150);   // 虚拟时间推进中错误可能晚到，周期性回写
})();
</script>
`;

// ── 探针 B：初始化后的 DOM 状态 + 模拟点击标签（在 </body> 前）──
const PROBE_B = `
<script>
(function(){
  var S = window.__smoke || (window.__smoke = { errors: [], checks: {} });
  var r = S.checks;
  function q(s){ return document.querySelector(s); }
  function qa(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function txt(el){ return el ? (el.textContent || '').trim() : null; }

  // 1) 先记录“静止状态”，必须在点击任何标签之前
  var panes = {};
  qa('.side-pane').forEach(function(p){ panes[p.getAttribute('data-pane')] = p.hasAttribute('hidden'); });
  var active = q('.side-tab.active');
  r.initial = {
    title: document.title,
    readyState: document.readyState,
    dateDisplay: txt(q('#dateDisplay')),
    sideTabCount: qa('#sideTabs .side-tab').length,
    panes: panes,
    activeTab: active ? active.getAttribute('data-tab') : null,
    taskListLen: q('#taskList') ? q('#taskList').innerHTML.length : -1,
    taskListEmptyState: qa('#taskList .empty-state').length,
    elements: ['taskList','alarmCard','ctxMenu','calendarWrap','focusWrap','sideTabs',
               'companionChip','settingsToggle','todayPill','modeBanner']
      .reduce(function(o, id){ o[id] = !!document.getElementById(id); return o; }, {})
  };

  // 2) 点「日历」标签，验证日历真的渲染出来
  try{
    var calTab = q('.side-tab[data-tab="calendar"]');
    if(calTab) calTab.click();
    var calPane = q('.side-pane[data-pane="calendar"]');
    r.calendar = {
      clicked: !!calTab,
      grid: qa('#calendarWrap .cal-grid').length,
      cells: qa('#calendarWrap .cal-cell').length,
      cellsWithAttr: qa('#calendarWrap .cal-cell[data-cal-day]').length,
      paneVisible: calPane ? !calPane.hasAttribute('hidden') : null
    };
  }catch(e){ r.calendar = { error: String(e) }; }

  // 3) 点「专注」标签，验证番茄钟渲染出来
  try{
    var focusTab = q('.side-tab[data-tab="focus"]');
    if(focusTab) focusTab.click();
    r.focus = {
      clicked: !!focusTab,
      focusClock: qa('#focusWrap #focusClock').length,
      clockText: txt(q('#focusWrap #focusClock'))
    };
  }catch(e){ r.focus = { error: String(e) }; }

  // 4) 切回详情，保持默认视图
  try{ var d = q('.side-tab[data-tab="detail"]'); if(d) d.click(); }catch(e){}

  if(window.__smokeFlush) window.__smokeFlush();
})();
</script>
`;

function injectProbes(html) {
  const head = /<head[^>]*>/i.exec(html);
  let out = head
    ? html.slice(0, head.index + head[0].length) + PROBE_A + html.slice(head.index + head[0].length)
    : PROBE_A + html;
  const body = /<\/body>/i.exec(out);
  out = body ? out.slice(0, body.index) + PROBE_B + out.slice(body.index) : out + PROBE_B;
  return out;
}

/** 复制源文件（最多 3 次）。源文件可能正被协作者写入，内容不完整就重试。 */
function copyWithRetry(src, dst) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const text = fs.readFileSync(src, 'utf8');
      if (!/<head[^>]*>/i.test(text) || !/<\/body>/i.test(text) || !/<\/html>\s*$/i.test(text)) {
        throw new Error('文件内容不完整（可能正在被写入）');
      }
      fs.writeFileSync(dst, injectProbes(text), 'utf8');
      return { bytes: Buffer.byteLength(text, 'utf8'), attempt };
    } catch (e) {
      lastErr = e;
      if (attempt < 3) sleepSync(300 * attempt);
    }
  }
  throw lastErr;
}

/** 启动 Edge 无头模式并等待结束；stdout/stderr 重定向到文件 */
function runEdge({ headlessFlag, url, profileDir, outFile, errFile }) {
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  try {
    const args = [
      headlessFlag, '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--enable-logging=stderr', '--v=1',
      '--user-data-dir=' + profileDir,
      '--virtual-time-budget=' + VIRTUAL_TIME_BUDGET,
      '--dump-dom', url,
    ];
    return spawnSync(EDGE, args, { stdio: ['ignore', outFd, errFd], timeout: 120000, windowsHide: true });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** dump-dom 序列化时会对文本做实体转义，读回来要还原（&amp; 必须最后处理） */
function unescapeHtml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function extractReport(dom) {
  const m = /<div id="__smoke_report"[^>]*>([\s\S]*?)<\/div>/i.exec(dom);
  if (!m) return null;
  try { return JSON.parse(unescapeHtml(m[1])); }
  catch (e) { return { __parseError: String(e), __raw: m[1].slice(0, 300) }; }
}

// Edge 自身噪声 / 网络噪声：打印但不作为断言依据
const NOISE = /edge_qqbrowser_importer|QQBrowser user data path|Google API keys|voice_transcription|device_event_log|registration_protocol/i;
const NET_NOISE = /ERR_CONNECTION_REFUSED|ERR_FILE_NOT_FOUND|ERR_NAME_NOT_RESOLVED|Failed to load resource/i;
const JS_ERR = /\[ERROR:CONSOLE|Uncaught|TypeError|ReferenceError|SyntaxError|is not defined|of null|of undefined/;

function classifyStderr(text) {
  const jsErrors = [], noise = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!/ERROR|Uncaught|TypeError|ReferenceError|SyntaxError|is not defined|of null|of undefined/.test(line)) continue;
    if (NOISE.test(line) || NET_NOISE.test(line)) noise.push(line.slice(0, 200));
    else if (JS_ERR.test(line)) jsErrors.push(line.slice(0, 300));
    else noise.push(line.slice(0, 200));
  }
  return { jsErrors, noise };
}

// ── 主流程 ─────────────────────────────────────────────────
const target = parseArgs(process.argv.slice(2));
if (!fs.existsSync(target)) {
  console.error(`❌ 找不到待测文件：${target}`);
  process.exit(1);
}
if (!fs.existsSync(EDGE)) {
  console.error(`❌ 找不到 Edge：${EDGE}`);
  process.exit(1);
}

const before = fs.statSync(target);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-smoke-'));
const profileDir = path.join(tmpRoot, 'edge-profile');
const outFile = path.join(tmpRoot, 'dom.html');
const errFile = path.join(tmpRoot, 'edge.log');
const copyPath = path.join(tmpRoot, 'app-copy.html');

console.log('════════ 今日事 · Edge 无头冒烟测试 ════════');
console.log(`待测源文件 : ${target}`);
console.log(`源文件大小 : ${before.size} 字节`);
console.log(`源文件写入 : ${before.mtime.toLocaleString('zh-CN')}（${before.mtime.toISOString()}）`);
console.log(`临时工作区 : ${tmpRoot}`);
console.log('');

const results = [];
function check(name, ok, evidence) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (evidence) console.log(`     证据：${String(evidence).slice(0, 400)}`);
}

let report = null, dom = '', flagUsed = '(未执行)', copyInfo = null, stderrText = '', edgeErr = null;

try {
  copyInfo = copyWithRetry(target, copyPath);
  console.log(`已复制副本并注入探针（第 ${copyInfo.attempt} 次尝试成功）`);
  fs.mkdirSync(profileDir, { recursive: true });
  const ico = path.join(path.dirname(target), 'app.ico');
  if (fs.existsSync(ico)) fs.copyFileSync(ico, path.join(tmpRoot, 'app.ico'));
  const url = pathToFileURL(copyPath).href;

  // 首选 --headless=new；拿不到 DOM 就退回 --headless
  flagUsed = '--headless=new';
  let r = runEdge({ headlessFlag: flagUsed, url, profileDir: path.join(copyPath, 'BADPROFILE'), outFile, errFile }); // TEMP-FALLBACK-TEST
  dom = readIfExists(outFile);
  edgeErr = r.error || (r.status !== 0 && r.status !== null ? new Error('退出码 ' + r.status) : null);
  if (!/<html/i.test(dom)) {
    console.log('⚠️  --headless=new 未产出 DOM，退回 --headless 重试…');
    flagUsed = '--headless';
    r = runEdge({ headlessFlag: flagUsed, url, profileDir, outFile, errFile });
    dom = readIfExists(outFile);
    edgeErr = r.error || (r.status !== 0 && r.status !== null ? new Error('退出码 ' + r.status) : null);
  }
  stderrText = readIfExists(errFile);
  console.log(`Edge 启动参数 : ${flagUsed}（DOM 输出 ${dom.length} 字节）`);
  console.log('');

  report = extractReport(dom);
  const init = report && report.checks && report.checks.initial;
  const cal = report && report.checks && report.checks.calendar;
  const foc = report && report.checks && report.checks.focus;
  const errs = (report && report.errors) || [];
  const fromProbe = !!(init && init.elements);
  const hasEl = id => fromProbe ? init.elements[id] === true : new RegExp('id="' + id + '"').test(dom);

  // ── 0. 探针本身可用（否则后续基于探针的断言不可信）
  check('注入探针成功回写报告（--dump-dom 中读到 #__smoke_report）', !!report && !report.__parseError,
    report ? (report.__parseError ? '解析失败：' + report.__parseError + ' 原文=' + report.__raw : '已解析到 JSON 报告')
           : '未找到 #__smoke_report');

  // ── 1. 标题
  const tm = /<title>([\s\S]*?)<\/title>/i.exec(dom);
  const title = tm ? unescapeHtml(tm[1]).trim() : '';
  check('页面标题存在且包含「今日事」', title.includes('今日事'), `title = "${title}"`);

  // ── 2. 无未捕获 JS 错误（探针为主）
  check('无未捕获的 JS 错误（注入探针为空）', errs.length === 0,
    errs.length ? errs.join(' ｜ ') : '探针 window.__smoke.errors 为空数组');

  // ── 3. 关键元素
  const KEY = ['taskList', 'alarmCard', 'ctxMenu', 'calendarWrap', 'focusWrap', 'sideTabs',
               'companionChip', 'settingsToggle', 'todayPill', 'modeBanner'];
  for (const id of KEY) {
    check(`关键元素 #${id} 已渲染`, hasEl(id),
      fromProbe ? `探针 document.getElementById('${id}') = ${init.elements[id]}` : 'dump-dom 文本匹配');
  }

  // ── 4. #taskList 有内容
  const emptyCount = fromProbe ? init.taskListEmptyState : (dom.match(/class="empty-state"/g) || []).length;
  check('#taskList 内有内容（空状态 .empty-state）', emptyCount >= 1,
    `#taskList.innerHTML 长度=${fromProbe ? init.taskListLen : '?'}，.empty-state 数量=${emptyCount}`);

  // ── 5. 初始化没有中断（最重要）
  const dateText = fromProbe ? init.dateDisplay : (/<div class="date" id="dateDisplay">([\s\S]*?)<\/div>/i.exec(dom) || [, ''])[1];
  check('【关键】初始化未中断：#dateDisplay 文本非空', !!(dateText && String(dateText).trim()),
    dateText === null ? '#dateDisplay 元素不存在（探针返回 null）' : `#dateDisplay = "${dateText}"`);

  // ── 6. 侧栏默认标签
  const panes = (fromProbe && init.panes) || null;
  const paneOk = panes && panes.detail === false &&
    ['calendar', 'stats', 'focus'].every(k => panes[k] === true);
  check('侧栏默认标签为「详情」：detail 可见、其余三个 hidden', !!paneOk,
    panes ? JSON.stringify(panes) + `（active=${init.activeTab}）` : '探针未返回 side-pane 状态');

  // ── 7. 侧栏 4 个标签
  const tabCount = fromProbe ? init.sideTabCount : (dom.match(/data-tab="/g) || []).length;
  check('#sideTabs 内有 4 个 .side-tab', tabCount === 4, `统计到 ${tabCount} 个`);

  // ── 8. 日历渲染
  check('点击「日历」后 #calendarWrap 渲染出 .cal-grid 与 ≥28 个 .cal-cell（均带 data-cal-day）',
    !!cal && cal.clicked && cal.grid >= 1 && cal.cells >= 28 && cal.cellsWithAttr === cal.cells,
    cal ? `grid=${cal.grid}, cell=${cal.cells}, 带 data-cal-day=${cal.cellsWithAttr}, 面板可见=${cal.paneVisible}`
        : '探针未返回日历结果');

  // ── 9. 专注渲染
  check('点击「专注」后 #focusWrap 内出现 #focusClock',
    !!foc && foc.clicked && foc.focusClock >= 1 && !!foc.clockText,
    foc ? `#focusClock 数量=${foc.focusClock}, 文本="${foc.clockText}"` : '探针未返回专注结果');

  // ── 10. 补充手段：Edge stderr 日志
  const { jsErrors, noise } = classifyStderr(stderrText);
  check('Edge stderr 日志中无 JS 异常（补充手段）', jsErrors.length === 0,
    jsErrors.length ? jsErrors.join(' ｜ ')
      : `未发现 CONSOLE/JS 异常；已忽略噪声 ${noise.length} 行（Edge 自身日志与网络失败）`);

  if (edgeErr) console.log(`\n⚠️  Edge 进程提示：${edgeErr.message}`);
  if (noise.length) {
    console.log('\nℹ️  已忽略的 stderr 噪声（前 5 行）：');
    noise.slice(0, 5).forEach(l => console.log('   · ' + l));
  }
} catch (e) {
  check('脚本自身执行未抛异常', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : String(e));
} finally {
  // 清理：Windows 上 profile 文件常被占用，失败只提示不报错
  let cleaned = false;
  for (let i = 0; i < 3 && !cleaned; i++) {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); cleaned = true; }
    catch { sleepSync(300); }
  }

  const after = fs.statSync(target);
  console.log('\n──────── 汇总 ────────');
  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log(`通过 ${passed} 条 / 失败 ${failed} 条（共 ${results.length} 条）`);
  if (failed) {
    console.log('失败条目：');
    results.filter(r => !r.ok).forEach(r => console.log('  ❌ ' + r.name));
  }
  console.log(`临时目录清理：${cleaned ? '已删除 ' + tmpRoot : '删除失败（文件被占用，可手动清理 ' + tmpRoot + '）'}`);
  const changed = after.size !== before.size || after.mtimeMs !== before.mtimeMs;
  console.log(`源文件复检：${after.size} 字节，写入时间 ${after.mtime.toISOString()}` +
    (changed ? '  ⚠️ 测试期间源文件发生了变化（协作者正在编辑）' : '  （与测试前一致）'));
  console.log(`结论：${failed === 0 ? '✅ 冒烟测试通过' : '❌ 冒烟测试失败'}`);

  if (failed) process.exitCode = 1;
}
