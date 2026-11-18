const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

class Element {
  constructor(id = '') { this.id = id; this.innerHTML = ''; this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false; this.open = false; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.tagName = 'BUTTON'; this.parentElement = { classList: { toggle() {} } }; this.classes = new Set(); this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) }; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  contains() { return false; }
  querySelectorAll() { return []; }
  querySelector() { return submit; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { document.activeElement = this; }
}
const elements = new Map();
const el = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
const nav = ['overview', 'processes', 'alerts'].map(name => { const item = new Element(); item.dataset.view = name; return item; });
const mini = Array.from({ length: 16 }, () => new Element());
const submit = new Element();
const document = {
  activeElement: { tagName: 'BODY' }, getElementById: el,
  querySelectorAll(selector) { return selector === '[data-view]' ? nav : selector === '.gpu-mini-grid i' ? mini : []; },
  querySelector() { return null; }, addEventListener() {}
};
let fetchImpl = async () => { throw new TypeError('network'); };
let fetchCalls = 0, timerId = 0;
const timers = new Map();
const stored = new Map();
const location = { protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:8765' };
const context = vm.createContext({
  document, location,
  localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
  window: { addEventListener() {} }, URL, Date, AbortController, TypeError, console,
  fetch: (...args) => { fetchCalls++; return fetchImpl(...args); },
  setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
  clearTimeout: id => timers.delete(id)
});
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const emit = async (element, type, extra = {}) => { for (const fn of element.listeners[type] || []) await fn({ target: element, preventDefault() {}, ...extra }); await settle(); };
const cards = () => (el('node-grid').innerHTML.match(/class="gpu-card /g) || []).length;
const response = payload => ({ ok: true, status: 200, json: async () => payload });
const appSource = fs.readFileSync(require('node:path').join(__dirname, '../dist/app.js'), 'utf8');
const live = (extra = {}) => ({ mode: 'live', timestamp: new Date().toISOString(), sampleIntervalSeconds: 2, nodes: [{ id: 'real-node', name: 'REAL-NODE', host: '127.0.0.1', status: 'online', sampledAt: new Date().toISOString(), cpuPercent: 10, ramUsedGb: 8, ramTotalGb: 32, uptimeSeconds: 3600, gpus: [{ index: 0, uuid: 'gpu-real', name: '<img src=x onerror=alert(1)>', utilization: 43, memoryUsedMb: 512, memoryTotalMb: 81920, temperature: 40, powerWatts: 100, processes: [{ pid: 71, user: '<script>bad()</script>', name: 'train.py', command: 'python train.py', memoryMb: 512, elapsedSeconds: 600 }] }] }], ...extra });
const saveConnection = async (mode = 'live', endpoint = 'http://127.0.0.1:8765/api/metrics', token = '') => {
  if (!el('connection-dialog').open) await emit(el('connect-btn'), 'click');
  el('connection-mode').value = mode; el('endpoint-input').value = endpoint; el('token-input').value = token;
  await emit(el('connection-form'), 'submit');
};

(async () => {
  fetchImpl = async (url) => {
    assert.equal(url, '/api/viewer');
    return { ok: false, status: 404 };
  };
  vm.runInContext(appSource, context); await settle();
  assert.match(el('stat-gpus').innerHTML, /^16 /); assert.equal(el('node-count').textContent, 2); assert.equal(cards(), 8); assert.equal(fetchCalls, 1);
  assert.match(el('data-notice').innerHTML, /模拟集群数据/);
  await emit(el('node-grid'), 'click', { target: { closest: selector => selector === '[data-expand]' ? { dataset: { expand: 'a800-01' } } : null } });
  assert.equal(cards(), 12);
  el('search-input').value = '王辰'; await emit(el('search-input'), 'input'); assert.equal(el('gpu-count').textContent, 2); assert.equal(el('process-count').textContent, '2 个进程');
  el('search-input').value = ''; await emit(el('search-input'), 'input'); el('status-filter').value = 'idle'; await emit(el('status-filter'), 'change'); assert.equal(el('gpu-count').textContent, 5);
  el('status-filter').value = 'busy'; await emit(el('status-filter'), 'change'); assert.equal(el('gpu-count').textContent, 11);
  el('node-filter').value = 'a800-01'; await emit(el('node-filter'), 'change'); assert.equal(el('gpu-count').textContent, 6);
  el('sort-select').value = 'utilization'; await emit(el('sort-select'), 'change'); assert.match(el('node-grid').innerHTML.match(/class="gpu-name">(.*?)<\/strong>/)[1], /GPU 1/);
  await emit(nav[1], 'click'); assert.equal(el('processes-view').hidden, false); assert.equal(el('overview-view').hidden, true);
  await emit(el('node-grid'), 'click', { target: { closest: selector => selector === '[data-detail-node]' ? { dataset: { detailNode: 'a800-01', detailGpu: '1' } } : null } });
  assert.equal(el('detail-dialog').open, true); assert.equal(el('detail-title').textContent, 'A800-01 · GPU 1'); assert.match(el('detail-content').innerHTML, /PID 28401/); await emit(el('close-detail'), 'click');
  await emit(el('pause-btn'), 'click'); assert.match(el('connection-status').textContent, /暂停/); assert.match(el('pause-btn').innerHTML, /继续/);
  await emit(el('refresh-btn'), 'click'); assert.match(el('connection-status').textContent, /暂停/);
  await emit(el('pause-btn'), 'click'); assert.match(el('connection-status').textContent, /演示/);
  await emit(el('connect-btn'), 'click'); assert.equal(el('connection-dialog').open, true); assert.equal(el('connection-mode').value, 'live');
  assert.equal(el('endpoint-input').value, 'http://127.0.0.1:8765/api/metrics');
  fetchImpl = async () => { throw new TypeError('network'); };
  await saveConnection(); assert.equal(el('mode-badge').textContent, '实时模式'); assert.match(el('data-notice').innerHTML, /无法连接监控接口/); assert.equal(cards(), 0); assert.match(el('alert-list').innerHTML, /等待首次资源采样/);
  let sentHeaders;
  fetchImpl = async (_, options) => { sentHeaders = options.headers; return response(live()); };
  await saveConnection('live', 'http://127.0.0.1:8765', 'secret-token');
  assert.equal(el('connection-dialog').open, false); assert.equal(el('connection-status').textContent, '实时连接正常');
  assert.match(el('stat-gpus-note').innerHTML, /1 张已占用/); assert.match(el('node-grid').innerHTML, /&lt;img/); assert.doesNotMatch(el('node-grid').innerHTML, /<img/); assert.doesNotMatch([...stored.values()].join(' '), /secret-token/);
  assert.equal(stored.get('observatory-endpoint'), 'http://127.0.0.1:8765/api/metrics');
  assert.equal(sentHeaders.Authorization, 'Bearer secret-token');
  fetchImpl = async () => { throw new TypeError('network'); }; await emit(el('refresh-btn'), 'click'); assert.match(el('data-notice').innerHTML, /保留最后一次成功采样/); assert.match(el('stat-gpus').innerHTML, /^1 /); assert.match(el('alert-list').innerHTML, /监控数据需要检查/);
  const old = new Date(Date.now() - 120000).toISOString();
  fetchImpl = async () => response(live({ timestamp: old, nodes: [{ ...live().nodes[0], sampledAt: old }] })); await emit(el('refresh-btn'), 'click'); assert.match(el('data-notice').innerHTML, /数据已过期/); assert.match(el('node-grid').innerHTML, /最后观测值/); assert.match(el('stat-util-note').textContent, /最后观测值/); assert.notEqual(el('connection-status').textContent, '实时连接正常');
  fetchImpl = async () => response(live({ timestamp: old, sampleIntervalSeconds: 60, nodes: [{ ...live().nodes[0], sampledAt: old }] })); await emit(el('refresh-btn'), 'click'); assert.equal(el('connection-status').textContent, '实时连接正常');
  fetchImpl = async () => response(live({ sampleIntervalSeconds: 2, nodes: [{ ...live().nodes[0], sampledAt: old, sampleIntervalSeconds: 60 }] })); await emit(el('refresh-btn'), 'click'); assert.equal(el('connection-status').textContent, '实时连接正常');
  fetchImpl = async () => response(live({ nodes: [{ ...live().nodes[0], gpus: [{ ...live().nodes[0].gpus[0], memoryUsedMb: 73728, temperature: 85 }] }] })); await emit(el('refresh-btn'), 'click'); assert.equal(el('alert-count').textContent, 2); assert.match(el('alert-list').innerHTML, /温度偏高/); assert.match(el('alert-list').innerHTML, /显存紧张/);
  fetchImpl = async () => response(live({ nodes: [{ ...live().nodes[0], status: 'offline', stale: true, sampledAt: old }] })); await emit(el('refresh-btn'), 'click'); assert.match(el('node-grid').innerHTML, /节点离线/); assert.match(el('data-notice').innerHTML, /最后观测值/); assert.equal(el('alert-count').textContent, 1);
  fetchImpl = async () => response(live({ nodes: [], collecting: true, warnings: ['采集器正在初始化'] })); await emit(el('refresh-btn'), 'click'); assert.match(el('data-notice').innerHTML, /采集器正在初始化/); assert.match(el('alert-list').innerHTML, /等待首次资源采样/); assert.match(el('node-grid').innerHTML, /等待服务器数据/);
  fetchImpl = async () => response(live({ mode: 'demo' })); await emit(el('refresh-btn'), 'click'); assert.match(el('data-notice').innerHTML, /数据模式不匹配/);
  fetchImpl = async () => response(live({ nodes: [{ ...live().nodes[0], gpus: [{ ...live().nodes[0].gpus[0], memoryUsedMb: null, processes: [] }] }] })); await emit(el('refresh-btn'), 'click');
  el('node-filter').value = 'all'; await emit(el('node-filter'), 'change'); el('status-filter').value = 'all'; await emit(el('status-filter'), 'change'); assert.match(el('node-grid').innerHTML, /状态未知/); assert.match(el('stat-gpus-note').innerHTML, /1 张未知/);
  let resolveLate;
  fetchImpl = () => new Promise(resolve => { resolveLate = resolve; });
  const callsBefore = fetchCalls;
  const lateRequest = emit(el('refresh-btn'), 'click'); await settle();
  await emit(el('refresh-btn'), 'click'); assert.equal(fetchCalls, callsBefore + 1);
  await saveConnection('demo'); assert.equal(el('mode-badge').textContent, '演示模式'); assert.equal(el('stat-gpus').innerHTML, '16 <small>张</small>');
  resolveLate(response(live())); await lateRequest;
  assert.equal(el('mode-badge').textContent, '演示模式'); assert.equal(el('stat-gpus').innerHTML, '16 <small>张</small>');
  console.log('PASS: frontend logical assertions covering demo, filters/search/sort/expand, navigation/details, pause/manual refresh, live failure/success, endpoint normalization, XSS escaping, token storage/authorization, offline/stale retention, aggregate/node freshness intervals, alerts, collecting, mode guard, unknown occupancy, no duplicate in-flight fetch, and late-response source-switch guard.');

  elements.clear();
  nav.forEach(button => { button.listeners = {}; });
  timers.clear();
  stored.clear();
  const requests = [];
  let finishProbe;
  let proxyResponse = response(live());
  fetchImpl = (url, options) => {
    requests.push({ url, options });
    if (url === '/api/viewer') return new Promise(resolve => { finishProbe = resolve; });
    assert.equal(url, '/api/connect');
    return Promise.resolve(proxyResponse);
  };
  vm.runInContext(appSource, context); await settle();
  assert.equal(el('stat-gpus').innerHTML, '16 <small>张</small>');
  assert.equal(requests.length, 1);
  await emit(el('connect-btn'), 'click');
  assert.equal(el('endpoint-input').value, '');
  const connect = saveConnection('live', 'http://linux-gpu.example:8765', 'viewer-test-token');
  await settle();
  assert.equal(requests.length, 1, 'submitting during detection never leaks a direct request');
  finishProbe(response({ mode: 'local-viewer' }));
  await connect;
  assert.equal(el('local-viewer-tip').hidden, false);
  assert.deepEqual(requests.map(request => request.url), ['/api/viewer', '/api/connect']);
  const { options } = requests[1];
  assert.equal(options.method, 'POST');
  assert.equal(options.mode, 'same-origin');
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), { endpoint: 'http://linux-gpu.example:8765/api/metrics', token: 'viewer-test-token' });
  assert.equal(stored.get('observatory-endpoint'), 'http://linux-gpu.example:8765/api/metrics');
  assert.equal(el('connection-status').textContent, '实时连接正常');
  await emit(el('refresh-btn'), 'click');
  assert.equal(requests[2].url, '/api/connect');
  assert.equal(requests[2].options.body, options.body);
  proxyResponse = { ok: false, status: 401, json: async () => ({ error: '采集器拒绝了令牌，请检查访问令牌。' }) };
  await emit(el('refresh-btn'), 'click');
  assert.equal(requests[3].url, '/api/connect');
  assert.match(el('data-notice').innerHTML, /拒绝了令牌/);
  assert.match(el('data-notice').innerHTML, /保留最后一次成功采样/);
  assert.match(el('stat-gpus').innerHTML, /^1 /);
  await saveConnection('live', 'https://linux-gpu.example/api/metrics?token=should-not-store');
  assert.match(el('connection-error').textContent, /不能包含查询参数/);
  assert.equal(requests.length, 4);
  await saveConnection('live', 'http://127.0.0.1:8765/api/metrics');
  assert.match(el('connection-error').textContent, /Linux 采集器的地址/);
  assert.equal(requests.length, 4);
  assert.deepEqual([...stored.values()], ['http://linux-gpu.example:8765/api/metrics']);
  console.log('PASS: local viewer discovery, race-safe same-origin POST, stored address without secrets, proxied polling/errors, and validation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
