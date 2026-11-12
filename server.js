// agent-team-demo: a tiny scripted multi-agent workbench.
// Node.js standard library only. No build step, no dependencies.
// The three agents are real pipeline steps that write real files and run real code:
//   planner  -> writes plan.md
//   coder    -> writes solution.js + test.js
//   reviewer -> runs `node test.js` and writes verdict.md
// They are scripted (template-based), NOT model calls: a skeleton for plugging
// real LLM calls in later. See README.md.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = 3000;
const DEMO_DIR = __dirname;
const RUNS_DIR = path.join(DEMO_DIR, 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- templates
// Coder maps a task to a known template by keyword. Unknown tasks get an
// honest stub that the reviewer will fail, instead of fake success.
const TEMPLATES = [
  {
    match: /palindrome|回文/,
    name: 'isPalindrome',
    code: "function isPalindrome(s) {\n  if (typeof s !== 'string') return false;\n  const t = s.replace(/[^a-z0-9]/gi, '').toLowerCase();\n  return t === t.split('').reverse().join('');\n}\nmodule.exports = isPalindrome;\n",
    test: "const assert = require('assert');\nconst isPalindrome = require('./solution.js');\nassert.strictEqual(isPalindrome('racecar'), true);\nassert.strictEqual(isPalindrome('RaceCar'), true);\nassert.strictEqual(isPalindrome('A man, a plan, a canal: Panama'), true);\nassert.strictEqual(isPalindrome('hello'), false);\nassert.strictEqual(isPalindrome(''), true);\nconsole.log('all palindrome tests passed');\n",
  },
  {
    match: /reverse.*string|反转.*字符串/,
    name: 'reverseString',
    code: "function reverseString(s) {\n  if (typeof s !== 'string') return '';\n  return s.split('').reverse().join('');\n}\nmodule.exports = reverseString;\n",
    test: "const assert = require('assert');\nconst reverseString = require('./solution.js');\nassert.strictEqual(reverseString('hello'), 'olleh');\nassert.strictEqual(reverseString(''), '');\nassert.strictEqual(reverseString('abc'), 'cba');\nconsole.log('all reverse-string tests passed');\n",
  },
  {
    match: /fizzbuzz/i,
    name: 'fizzBuzz',
    code: "function fizzBuzz(n) {\n  const out = [];\n  for (let i = 1; i <= n; i++) {\n    if (i % 15 === 0) out.push('FizzBuzz');\n    else if (i % 3 === 0) out.push('Fizz');\n    else if (i % 5 === 0) out.push('Buzz');\n    else out.push(String(i));\n  }\n  return out;\n}\nmodule.exports = fizzBuzz;\n",
    test: "const assert = require('assert');\nconst fizzBuzz = require('./solution.js');\nassert.deepStrictEqual(fizzBuzz(5), ['1', '2', 'Fizz', '4', 'Buzz']);\nassert.strictEqual(fizzBuzz(15)[14], 'FizzBuzz');\nconsole.log('all fizzbuzz tests passed');\n",
  },
  {
    match: /factorial|阶乘/,
    name: 'factorial',
    code: "function factorial(n) {\n  if (!Number.isInteger(n) || n < 0) throw new Error('n must be a non-negative integer');\n  let r = 1;\n  for (let i = 2; i <= n; i++) r *= i;\n  return r;\n}\nmodule.exports = factorial;\n",
    test: "const assert = require('assert');\nconst factorial = require('./solution.js');\nassert.strictEqual(factorial(0), 1);\nassert.strictEqual(factorial(5), 120);\nassert.strictEqual(factorial(10), 3628800);\nconsole.log('all factorial tests passed');\n",
  },
  {
    match: /fibonacci|斐波那契/,
    name: 'fibonacci',
    code: "function fibonacci(n) {\n  if (!Number.isInteger(n) || n < 0) throw new Error('n must be a non-negative integer');\n  let a = 0, b = 1;\n  for (let i = 0; i < n; i++) { const t = a + b; a = b; b = t; }\n  return a;\n}\nmodule.exports = fibonacci;\n",
    test: "const assert = require('assert');\nconst fibonacci = require('./solution.js');\nassert.strictEqual(fibonacci(0), 0);\nassert.strictEqual(fibonacci(1), 1);\nassert.strictEqual(fibonacci(10), 55);\nconsole.log('all fibonacci tests passed');\n",
  },
  {
    match: /prime|素数|质数/,
    name: 'isPrime',
    code: "function isPrime(n) {\n  if (!Number.isInteger(n) || n < 2) return false;\n  for (let i = 2; i * i <= n; i++) { if (n % i === 0) return false; }\n  return true;\n}\nmodule.exports = isPrime;\n",
    test: "const assert = require('assert');\nconst isPrime = require('./solution.js');\nassert.strictEqual(isPrime(2), true);\nassert.strictEqual(isPrime(17), true);\nassert.strictEqual(isPrime(15), false);\nassert.strictEqual(isPrime(1), false);\nconsole.log('all prime tests passed');\n",
  },
];

// ---------------------------------------------------------------- state
let current = null;
const history = [];

function newRun(task) {
  const id = Date.now().toString(36);
  const dir = path.join(RUNS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const run = {
    id, task, dir,
    startedAt: new Date().toISOString(),
    status: 'running',
    agents: { planner: 'waiting', coder: 'waiting', reviewer: 'waiting' },
    log: [],
    verdict: null,
  };
  current = run;
  return run;
}

function logLine(run, agent, msg) {
  const line = '[' + new Date().toISOString().slice(11, 19) + '] [' + agent + '] ' + msg;
  run.log.push(line);
  fs.appendFileSync(path.join(run.dir, 'log.txt'), line + '\n');
}

// ---------------------------------------------------------------- pipeline
async function runPipeline(task) {
  const run = newRun(task);
  const dir = run.dir;
  try {
    // --- planner
    run.agents.planner = 'working';
    logLine(run, 'planner', 'received task: ' + task);
    await sleep(700);
    const tpl = TEMPLATES.find((t) => t.match.test(task));
    const fnName = tpl ? tpl.name : 'solve';
    const steps = [
      '1. Parse the task and decide the function name and signature (' + fnName + ').',
      '2. Handle edge cases (empty input, wrong types, boundary values).',
      '3. Implement the core logic in solution.js.',
      '4. Write test.js with representative cases and let Reviewer run it.',
    ];
    const plan = '# Plan\n\nTask: ' + task + '\n\n## Steps\n\n' + steps.join('\n') + '\n\n## Target\n\n- Function: `' + fnName + '`\n- File: solution.js\n- Tests: test.js (run with `node test.js`)\n';
    fs.writeFileSync(path.join(dir, 'plan.md'), plan);
    logLine(run, 'planner', 'broke the task into ' + steps.length + ' steps, wrote plan.md');
    run.agents.planner = 'done';
    await sleep(500);

    // --- coder
    run.agents.coder = 'working';
    if (tpl) {
      logLine(run, 'coder', 'matched template "' + tpl.name + '", writing solution.js + test.js');
      fs.writeFileSync(path.join(dir, 'solution.js'), tpl.code);
      fs.writeFileSync(path.join(dir, 'test.js'), tpl.test);
    } else {
      logLine(run, 'coder', 'no template matches this task; writing an honest stub so Reviewer can fail it');
      fs.writeFileSync(path.join(dir, 'solution.js'),
        '// TODO: no template matches this task yet.\n// A real model-backed coder would implement it here.\nfunction solve() { throw new Error("not implemented: no template for this task"); }\nmodule.exports = solve;\n');
      fs.writeFileSync(path.join(dir, 'test.js'),
        "console.error('no tests: coder could not map the task to a known template');\nprocess.exit(1);\n");
    }
    logLine(run, 'coder', 'wrote solution.js and test.js');
    run.agents.coder = 'done';
    await sleep(500);

    // --- reviewer
    run.agents.reviewer = 'working';
    logLine(run, 'reviewer', 'running `node test.js` ...');
    const result = await new Promise((resolve) => {
      execFile('node', ['test.js'], { cwd: dir, timeout: 15000 }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
    const passed = result.code === 0;
    run.status = passed ? 'PASS' : 'FAIL';
    run.verdict = passed ? 'PASS' : 'FAIL';
    const verdict = '# Verdict: ' + run.verdict + '\n\nTask: ' + task + '\n\nCommand: `node test.js`\nExit code: ' + result.code + '\n\n## stdout\n\n```\n' + (result.stdout || '(empty)') + '```\n\n## stderr\n\n```\n' + (result.stderr || '(empty)') + '```\n';
    fs.writeFileSync(path.join(dir, 'verdict.md'), verdict);
    logLine(run, 'reviewer', 'test exit code ' + result.code + ' -> verdict: ' + run.verdict);
    run.agents.reviewer = 'done';
    logLine(run, 'system', 'run ' + run.id + ' finished: ' + run.verdict);
  } catch (err) {
    run.status = 'FAIL';
    run.verdict = 'FAIL';
    logLine(run, 'system', 'pipeline error: ' + (err && err.message ? err.message : err));
    try { fs.writeFileSync(path.join(dir, 'verdict.md'), '# Verdict: FAIL\n\nPipeline error: ' + (err && err.message ? err.message : err) + '\n'); } catch (e) {}
    for (const a of Object.keys(run.agents)) if (run.agents[a] === 'working') run.agents[a] = 'done';
  }
  history.unshift({ id: run.id, task: run.task, status: run.status, startedAt: run.startedAt, verdict: run.verdict });
  if (history.length > 5) history.pop();
}

// ---------------------------------------------------------------- http
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 20000) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

const AGENT_META = [
  { id: 'planner', name: 'Planner', desc: '把任务拆成 2-4 个步骤，写出 plan.md' },
  { id: 'coder', name: 'Coder', desc: '按计划写 solution.js 和测试 test.js' },
  { id: 'reviewer', name: 'Reviewer', desc: '跑 node test.js，写出 PASS / FAIL 结论' },
];

function dashboardHtml() {
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Agent Team Demo</title>\n<style>\nbody{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#1c1c1e;background:#fbfbfd}\nh1{font-size:24px} .sub{color:#666;margin-top:-8px}\n.agent{border:1px solid #ddd;border-radius:12px;padding:12px 16px;margin:10px 0;background:#fff}\n.agent h3{margin:0 0 4px;font-size:16px}\n.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600}\n.waiting{background:#eee;color:#666}.working{background:#fff3cd;color:#7a5b00}.done{background:#d4edda;color:#155724}\npre{background:#111;color:#d6ffd6;padding:12px;border-radius:8px;overflow:auto;max-height:320px;font-size:13px}\nform{margin:16px 0} input[type=text]{width:70%;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:14px}\nbutton{padding:10px 18px;border:0;border-radius:8px;background:#007aff;color:#fff;font-size:14px;cursor:pointer}\nbutton:disabled{background:#999}\n.verdict{font-size:20px;font-weight:700}.pass{color:#1a7f37}.fail{color:#cf222e}\n.files a{margin-right:12px}\n.note{color:#666;font-size:13px}\n</style>\n</head>\n<body>\n<h1>Agent Team Demo</h1>\n<p class="sub">一个迷你多 Agent 协作台：Planner → Coder → Reviewer，三步都在这台云电脑上真实执行。</p>\n<form id="taskForm">\n<input type="text" name="task" placeholder="输入一个小编程任务，例如：write a function that checks if a string is a palindrome" required>\n<button type="submit" id="goBtn">开始</button>\n</form>\n<div id="hint" class="note">支持的任务模板：palindrome（回文）、reverse string、fizzbuzz、factorial、fibonacci、prime。其他任务会如实失败，不会假装成功。</div>\n<div id="agents"></div>\n<div id="verdict"></div>\n<div id="files" class="files"></div>\n<h3>Live log</h3>\n<pre id="log">(暂无运行)</pre>\n<h3>最近运行</h3>\n<ul id="history"></ul>\n<p class="note">注意：三个 Agent 目前是脚本化的流水线（模板匹配 + 真实跑代码），不是模型调用；以后可以在 coder 里接真实的模型 API。云电脑空闲 30 分钟会自动暂停，单次最长运行 2 小时，页面睡着了就等它醒来。</p>\n<script>\nasync function refresh(){\n  try{\n    const r = await fetch("/state"); const s = await r.json();\n    const run = s.current;\n    const box = document.getElementById("agents");\n    const meta = ' + JSON.stringify(AGENT_META) + ';\n    if(!run){ box.innerHTML = "<p class=\\"note\\">还没有运行过任务。</p>"; document.getElementById("log").textContent = "(暂无运行)"; }\n    else {\n      box.innerHTML = meta.map(function(m){\n        const st = run.agents[m.id];\n        const label = st === "waiting" ? "等待" : st === "working" ? "工作中…" : "完成";\n        return "<div class=\\"agent\\"><h3>" + m.name + " <span class=\\"badge " + st + "\\">" + label + "</span></h3><div class=\\"note\\">" + m.desc + "</div></div>";\n      }).join("") + "<p><b>任务：</b>" + escapeHtml(run.task) + "</p>";\n      document.getElementById("log").textContent = run.log.join("\\n") || "(等待日志…)";\n      document.getElementById("verdict").innerHTML = run.verdict ? ("<p class=\\"verdict " + (run.verdict === "PASS" ? "pass" : "fail") + "\\">结论： " + run.verdict + "</p>") : "";\n      const files = ["plan.md","solution.js","test.js","verdict.md","log.txt"];\n      document.getElementById("files").innerHTML = "<b>产物：</b>" + files.map(function(f){ return "<a href=\\"/artifacts/" + run.id + "/" + f + "\\" target=\\"_blank\\">" + f + "</a>"; }).join("");\n      document.getElementById("goBtn").disabled = run.status === "running";\n    }\n    document.getElementById("history").innerHTML = s.history.map(function(h){ return "<li>" + escapeHtml(h.task) + " — <b>" + h.status + "</b> <span class=\\"note\\">" + h.startedAt + "</span></li>"; }).join("") || "<li class=\\"note\\">暂无</li>";\n  }catch(e){}\n}\nfunction escapeHtml(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }\ndocument.getElementById("taskForm").addEventListener("submit", async function(ev){\n  ev.preventDefault();\n  const task = ev.target.task.value;\n  const res = await fetch("/run", { method: "POST", headers: {"Content-Type":"application/x-www-form-urlencoded"}, body: "task=" + encodeURIComponent(task) });\n  if(res.status === 409){ alert("已有任务在运行，稍等一下"); return; }\n  ev.target.task.value = "";\n  refresh();\n});\nrefresh(); setInterval(refresh, 1000);\n</script>\n</body>\n</html>\n';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(dashboardHtml());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ current, history }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/run') {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const task = (params.get('task') || '').trim().slice(0, 500);
    if (!task) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'empty task' })); return; }
    if (current && current.status === 'running') { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'a run is already in progress' })); return; }
    runPipeline(task); // fire and forget; dashboard polls /state
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, task }));
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/artifacts/')) {
    const parts = url.pathname.split('/').filter(Boolean); // artifacts, id, file
    const allowed = ['plan.md', 'solution.js', 'test.js', 'verdict.md', 'log.txt'];
    if (parts.length === 3 && allowed.includes(parts[2]) && /^[a-z0-9]+$/.test(parts[1])) {
      const fp = path.join(RUNS_DIR, parts[1], parts[2]);
      if (fs.existsSync(fp)) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(fs.readFileSync(fp, 'utf8'));
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log('agent-team-demo listening on port ' + PORT);
});
