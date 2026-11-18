/* GPU Observatory — dependency-free live monitoring client. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const clamp = (value, max = 100) => value === null ? null : Math.max(0, Math.min(max, value));
  const percent = (value) => value === null ? '—' : `${Math.round(value)}%`;
  const gb = (mb, digits = 1) => mb === null ? '—' : (mb / 1024).toLocaleString('en-US', { maximumFractionDigits: digits });
  const pretty = (value, digits = 0) => value === null ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: digits });
  const sum = (values) => values.reduce((total, value) => total + (value ?? 0), 0);
  const average = (values) => {
    const known = values.filter((value) => value !== null);
    return known.length ? sum(known) / known.length : null;
  };
  const duration = (seconds) => {
    if (seconds === null) return '—';
    if (seconds < 60) return `${Math.floor(seconds)} 秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
    return `${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时`;
  };
  const memoryRatio = (gpu) => gpu.memoryUsedMb !== null && gpu.memoryTotalMb > 0 ? gpu.memoryUsedMb / gpu.memoryTotalMb * 100 : null;
  const isBusy = (gpu) => (gpu.memoryUsedMb ?? 0) > 0 || gpu.processes.length > 0;
  const occupancyKnown = (gpu) => gpu.memoryUsedMb !== null || gpu.processes.length > 0;
  const state = {
    mode: 'demo', nodes: [], timestamp: null, received: false, error: '', paused: false,
    view: 'overview', search: '', nodeFilter: 'all', statusFilter: 'all', sort: 'default',
    interval: 2000, endpoint: '', token: '', timer: null, abort: null, busy: false,
    generation: 0, expanded: new Set(), history: [], detail: null, tick: 0, warnings: [], collecting: false, maxAgeMs: 15000
  };
  const endpointKey = 'observatory-endpoint';
  const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];
  const directEndpoint = /^https?:$/.test(location.protocol) ? `${location.origin}/api/metrics` : 'http://127.0.0.1:8765/api/metrics';
  try {
    const rememberedEndpoint = localStorage.getItem(endpointKey);
    if (rememberedEndpoint) {
      const url = new URL(rememberedEndpoint);
      if (url.username || url.password || /[?#]/.test(url.href)) localStorage.removeItem(endpointKey);
      else state.endpoint = rememberedEndpoint;
    }
  } catch { /* Storage may be disabled or contain an invalid old setting. */ }
  let transport = 'checking';
  let viewerReady;
  let connectionDialogVersion = 0;

  async function detectTransport() {
    if (location.protocol !== 'http:' || !loopbackHosts.includes(location.hostname)) return 'direct';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800);
    try {
      const response = await fetch('/api/viewer', {
        headers: { Accept: 'application/json' }, signal: controller.signal,
        cache: 'no-store', credentials: 'omit', redirect: 'error'
      });
      if (response.status === 404) return 'direct';
      if (!response.ok) return 'unavailable';
      const marker = await response.json();
      return marker?.mode === 'local-viewer' ? 'viewer' : 'direct';
    } catch {
      return 'unavailable';
    } finally {
      clearTimeout(timeout);
    }
  }

  function avatar(user) {
    const colors = ['teal', 'blue', 'amber', 'purple'];
    const hash = [...user].reduce((result, character) => result + character.codePointAt(0), 0);
    const initial = /^[a-z]/i.test(user) ? user.slice(0, 1).toUpperCase() : user.slice(-2);
    return `<span class="avatar" data-color="${colors[hash % colors.length]}">${escapeHtml(initial || '?')}</span>`;
  }

  function demoSnapshot() {
    const tick = state.tick++;
    const process = (pid, user, name, memoryMb, elapsedSeconds) => ({ pid, user, name, command: `${name} --model /models/checkpoint`, memoryMb, elapsedSeconds: elapsedSeconds + tick * state.interval / 1000 });
    const nodes = [
      { id: 'a800-01', name: 'A800-01', host: '10.10.0.21', cpuPercent: 34, ramUsedGb: 218, ramTotalGb: 512, uptimeSeconds: 349240, status: 'online',
        utilization: [0, 82, 0, 73, 45, 60, 0, 0], memory: [16384, 71680, 16384, 67584, 32768, 46080, 0, 0],
        processes: [
          [process(18242, '林晓', 'vllm-server', 16384, 269820)],
          [process(18242, '林晓', 'vllm-server', 16384, 269820), process(28401, '林晓', 'train.py', 55296, 13710)],
          [process(18242, '林晓', 'vllm-server', 16384, 269820)],
          [process(31955, 'root', 'python worker.py', 64512, 1452)],
          [process(24908, '王辰', 'finetune.py', 32768, 19280)],
          [process(29172, '陈宇', 'torchrun', 46080, 20840)], [], []
        ] },
      { id: 'a800-02', name: 'A800-02', host: '10.10.0.22', cpuPercent: 21, ramUsedGb: 156, ramTotalGb: 512, uptimeSeconds: 628140, status: 'online',
        utilization: [0, 35, 0, 35, 0, 72, 0, 52], memory: [30720, 30720, 0, 30720, 0, 73728, 0, 45056],
        processes: [
          [process(21470, '陈宇', 'inference.py', 30720, 6420)],
          [process(21470, '陈宇', 'inference.py', 30720, 6420)], [],
          [process(21470, '陈宇', 'inference.py', 30720, 6420)], [],
          [process(31022, '王辰', 'train_lora.py', 73728, 36150)], [],
          [process(29113, '林晓', 'python evaluate.py', 45056, 18200)]
        ] }
    ];
    return {
      mode: 'demo', timestamp: new Date().toISOString(), nodes: nodes.map((node, n) => ({
        ...node, cpuPercent: Math.round(node.cpuPercent + Math.sin(tick * .7 + n) * 3),
        uptimeSeconds: node.uptimeSeconds + tick * state.interval / 1000,
        gpus: node.utilization.map((base, index) => ({
          index, uuid: `demo-${n}-${index}`, name: 'NVIDIA A800-SXM4-80GB',
          utilization: base ? Math.round(clamp(base + Math.sin(tick * .61 + index * 2 + n) * 4)) : 0,
          memoryUsedMb: node.memory[index], memoryTotalMb: 81920,
          temperature: Math.round(29 + base * .29 + Math.sin(tick * .3 + index) * 2),
          powerWatts: Math.round(62 + base * 2.7 + Math.sin(tick + index) * 4), processes: node.processes[index]
        }))
      }))
    };
  }

  function validateSnapshot(payload) {
    if (!payload || !Array.isArray(payload.nodes) || !Number.isFinite(Date.parse(payload.timestamp))) throw new Error('接口数据格式不正确，请使用配套采集程序的 /api/metrics 接口。');
    if (payload.mode !== state.mode) throw new Error('数据模式不匹配，实时模式必须连接返回 mode: live 的真实采集接口。');
    const maxAgeMs = Math.max(15000, (number(payload.sampleIntervalSeconds) > 0 ? payload.sampleIntervalSeconds * 1000 : state.interval) * 3);
    const seen = new Set();
    const nodes = payload.nodes.map((node, index) => {
      if (!node || !Array.isArray(node.gpus)) throw new Error('节点缺少 GPU 数据，请检查采集程序版本。');
      const id = String(node.id ?? `node-${index}`);
      if (seen.has(id)) throw new Error('接口返回了重复的节点 ID，请检查节点配置。');
      seen.add(id);
      const sampledAt = Number.isFinite(Date.parse(node.sampledAt)) ? node.sampledAt : node.status === 'online' ? payload.timestamp : null;
      const nodeMaxAgeMs = number(node.sampleIntervalSeconds) > 0 ? Math.max(15000, node.sampleIntervalSeconds * 3000) : maxAgeMs;
      return {
        id, name: String(node.name || id), host: String(node.host || '—'), status: String(node.status || 'unknown'),
        cpuPercent: clamp(number(node.cpuPercent)), ramUsedGb: clamp(number(node.ramUsedGb), Infinity),
        ramTotalGb: clamp(number(node.ramTotalGb), Infinity), uptimeSeconds: clamp(number(node.uptimeSeconds), Infinity),
        sampledAt,
        stale: node.stale === true || (sampledAt !== null && Date.now() - Date.parse(sampledAt) > nodeMaxAgeMs),
        warnings: Array.isArray(node.warnings) ? node.warnings.map(String) : [],
        gpus: node.gpus.map((gpu, gpuIndex) => ({
          index: number(gpu.index) ?? gpuIndex, uuid: String(gpu.uuid ?? `${id}-${gpuIndex}`), name: String(gpu.name || 'NVIDIA GPU'),
          utilization: clamp(number(gpu.utilization)), memoryUsedMb: clamp(number(gpu.memoryUsedMb), Infinity),
          memoryTotalMb: clamp(number(gpu.memoryTotalMb), Infinity), temperature: number(gpu.temperature), powerWatts: clamp(number(gpu.powerWatts), Infinity),
          processes: (Array.isArray(gpu.processes) ? gpu.processes : []).map((process) => ({
            pid: number(process.pid), user: String(process.user || '未知用户'), name: String(process.name || '未知进程'),
            command: String(process.command || process.name || ''), memoryMb: clamp(number(process.memoryMb), Infinity),
            elapsedSeconds: clamp(number(process.elapsedSeconds), Infinity)
          }))
        }))
      };
    });
    return { nodes, timestamp: payload.timestamp, warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [], collecting: payload.collecting === true, maxAgeMs };
  }

  function allProcesses(nodes = state.nodes) {
    const processes = new Map();
    nodes.forEach((node) => node.gpus.forEach((gpu) => gpu.processes.forEach((process, pIndex) => {
      const key = `${node.id}\u0000${process.pid ?? `${gpu.index}-${pIndex}`}`;
      if (!processes.has(key)) processes.set(key, { ...process, node, gpus: [], memoryMb: null });
      const entry = processes.get(key);
      entry.gpus.push(gpu.index);
      if (process.memoryMb !== null) entry.memoryMb = (entry.memoryMb ?? 0) + process.memoryMb;
    })));
    return [...processes.values()];
  }

  function updateHistory() {
    const gpus = state.nodes.flatMap((node) => node.gpus);
    state.history.push({ utilization: average(gpus.map((gpu) => gpu.utilization)), memory: sum(gpus.map((gpu) => gpu.memoryUsedMb)) / 1024 });
    if (state.history.length > 30) state.history.shift();
  }

  function sparkline(id, key) {
    const element = $(id);
    if (!element) return;
    const values = state.history.map((sample) => sample[key]).filter((value) => value !== null);
    if (values.length < 2) { element.innerHTML = ''; return; }
    const min = Math.min(...values), max = Math.max(...values);
    const range = Math.max(max - min, key === 'utilization' ? 8 : 10);
    const path = values.map((value, index) => `${index ? 'L' : 'M'}${(index / (values.length - 1) * 120).toFixed(2)},${(30 - (value - min) / range * 24).toFixed(2)}`).join(' ');
    element.innerHTML = `<path class="spark-area" d="${path} L120,35 L0,35 Z"/><path class="spark-line" d="${path}"/>`;
  }

  function renderStats() {
    const gpus = state.nodes.flatMap((node) => node.gpus);
    const busy = gpus.filter(isBusy).length;
    const unknown = gpus.filter((gpu) => !occupancyKnown(gpu)).length;
    const processes = allProcesses();
    const used = gpus.some((gpu) => gpu.memoryUsedMb !== null) ? sum(gpus.map((gpu) => gpu.memoryUsedMb)) : null;
    const total = gpus.some((gpu) => gpu.memoryTotalMb !== null) ? sum(gpus.map((gpu) => gpu.memoryTotalMb)) : null;
    const avg = average(gpus.map((gpu) => gpu.utilization));
    $('stat-gpus').innerHTML = `${state.received ? gpus.length : '—'} <small>张</small>`;
    $('stat-gpus-note').innerHTML = state.received ? `<span class="stat-accent">${busy} 张已占用</span><span class="stat-dot">·</span>${gpus.length - busy - unknown} 张空闲${unknown ? ` · ${unknown} 张未知` : ''}` : '等待服务器首次采样';
    $('stat-util').innerHTML = `${avg === null ? '—' : Math.round(avg)}<small>${avg === null ? '' : '%'}</small>`;
    $('stat-util-note').textContent = gpus.length ? `${state.nodes.length} 个节点 · ${state.nodes.some((node) => node.status !== 'online' || node.stale) || Date.now() - Date.parse(state.timestamp) > state.maxAgeMs ? '含离线或过期节点最后观测值' : '所有显卡的平均值'}` : '暂无 GPU 采样';
    $('stat-memory').innerHTML = `${gb(used, 0)} <small>GB</small>`;
    $('stat-memory-note').textContent = total === null ? '等待显存数据' : `共 ${gb(total, 0)} GB · 已使用 ${Math.round(used / total * 100 || 0)}%`;
    $('stat-processes').innerHTML = `${state.received ? processes.length : '—'} <small>个</small>`;
    $('stat-processes-note').textContent = state.received ? `${new Set(processes.map((process) => process.user)).size} 位用户正在使用 GPU` : '等待计算进程数据';
    document.querySelectorAll('.gpu-mini-grid i').forEach((element, index) => { element.classList.toggle('occupied', index < busy); element.hidden = index >= gpus.length; });
    sparkline('spark-util', 'utilization'); sparkline('spark-memory', 'memory');
  }

  function processMatches(process) {
    return `${process.user} ${process.pid ?? ''} ${process.name} ${process.command}`.toLowerCase().includes(state.search);
  }
  function gpuMatches(node, gpu) {
    if (state.statusFilter === 'busy' && !isBusy(gpu)) return false;
    if (state.statusFilter === 'idle' && (isBusy(gpu) || !occupancyKnown(gpu))) return false;
    if (!state.search) return true;
    return `${node.name} ${node.host} GPU ${gpu.index} ${gpu.uuid} ${gpu.name}`.toLowerCase().includes(state.search) || gpu.processes.some(processMatches);
  }

  function processRow(process) {
    return `<div class="process-row">${avatar(process.user)}<span class="process-user" title="${escapeHtml(process.user)}">${escapeHtml(process.user)}</span><span class="process-memory">${gb(process.memoryMb)} <small>GB</small></span><span class="process-command" title="PID ${escapeHtml(process.pid)} · ${escapeHtml(process.command)}">${escapeHtml(process.name)}</span><span class="process-time">${duration(process.elapsedSeconds)}</span></div>`;
  }

  function gpuCard(node, gpu) {
    const level = (gpu.utilization ?? 0) >= 70 ? 'hot' : isBusy(gpu) ? 'warm' : occupancyKnown(gpu) ? 'idle' : 'unknown';
    const ratio = memoryRatio(gpu);
    return `<article class="gpu-card ${level}" role="button" tabindex="0" data-focus-key="gpu:${escapeHtml(node.id)}:${gpu.index}" data-detail-node="${escapeHtml(node.id)}" data-detail-gpu="${gpu.index}" aria-label="查看 ${escapeHtml(node.name)} GPU ${gpu.index} 详情">
      <div class="gpu-top"><div class="gpu-ident"><strong class="gpu-name">GPU ${gpu.index}</strong><span class="gpu-model">${escapeHtml(gpu.name)}</span></div><strong class="gpu-util">${percent(gpu.utilization)}</strong></div>
      <div class="progress-track" aria-label="GPU 利用率 ${percent(gpu.utilization)}"><div class="progress-fill" style="width:${gpu.utilization ?? 0}%"></div></div>
      <div class="gpu-meta"><span>${icon('memory')}${gb(gpu.memoryUsedMb)} / ${gb(gpu.memoryTotalMb, 0)} GB</span><span>${icon('thermometer')}${pretty(gpu.temperature)}°C</span><span>${icon('zap')}${pretty(gpu.powerWatts)} W</span><span class="gpu-memory-percent">${percent(ratio)} 显存</span></div>
      <div class="process-list">${gpu.processes.length ? gpu.processes.slice(0, 2).map(processRow).join('') + (gpu.processes.length > 2 ? `<div class="gpu-footer">另有 ${gpu.processes.length - 2} 个进程，点击查看</div>` : '') : `<div class="empty-process"><span class="idle-dot"></span>${occupancyKnown(gpu) ? '暂无计算进程' : '占用信息不可用'}<span class="gpu-status">${isBusy(gpu) ? '显存已分配' : occupancyKnown(gpu) ? '可分配' : '状态未知'}</span></div>`}</div>
    </article>`;
  }

  function nodeCard(node, gpus) {
    const all = node.gpus;
    const busy = all.filter(isBusy).length;
    const memoryUsed = all.some((gpu) => gpu.memoryUsedMb !== null) ? sum(all.map((gpu) => gpu.memoryUsedMb)) : null;
    const memoryTotal = all.some((gpu) => gpu.memoryTotalMb !== null) ? sum(all.map((gpu) => gpu.memoryTotalMb)) : null;
    const expanded = state.expanded.has(node.id);
    const visible = expanded ? gpus : gpus.slice(0, 4);
    return `<section class="node-card">
      <div class="node-header"><span class="node-icon">${icon('server')}</span><div class="node-heading"><h3 class="node-name">${escapeHtml(node.name)}</h3><span class="node-host">${escapeHtml(node.host)}</span></div><span class="badge ${node.status === 'online' && !node.stale ? 'online' : 'offline'}"><i></i>${node.status !== 'online' ? '节点离线' : node.stale ? '数据已过期' : `${all.length} 张 GPU`}</span></div>
      <div class="node-summary"><div class="metric"><span class="summary-label">平均利用率</span><strong class="summary-value">${percent(average(all.map((gpu) => gpu.utilization)))}</strong></div><div class="metric"><span class="summary-label">显存占用</span><strong class="summary-value">${gb(memoryUsed, 0)} <small>GB <span>/ ${gb(memoryTotal, 0)}</span></small></strong></div><div class="metric busy-metric"><span class="summary-label">已占用${all.some((gpu) => !occupancyKnown(gpu)) ? ' · 部分未知' : ''}</span><strong class="summary-value">${busy} <small>/ ${all.length}</small><span class="busy-indicator"></span></strong></div></div>
      <div class="node-system"><span>CPU <strong>${percent(node.cpuPercent)}</strong></span><span>内存 <strong>${pretty(node.ramUsedGb, 0)} / ${pretty(node.ramTotalGb, 0)} GB</strong></span><span class="node-uptime">${icon('clock')}已运行 ${duration(node.uptimeSeconds)}</span></div>
      ${node.warnings?.length ? `<div class="node-warning">${icon('info')}<span>${escapeHtml(node.warnings.join(' · '))}</span></div>` : ''}
      ${node.status !== 'online' || node.stale ? `<div class="node-warning">${icon('clock')}<span>${node.sampledAt ? `以下为最后观测值 · ${escapeHtml(new Date(node.sampledAt).toLocaleString('zh-CN', { hour12: false }))}` : '尚未收到该节点的首次采样'}</span></div>` : ''}
      <div class="gpu-list">${visible.length ? visible.map((gpu) => gpuCard(node, gpu)).join('') : `<div class="empty-state">${node.status === 'online' ? '未检测到可用的 NVIDIA GPU' : '等待节点恢复连接'}</div>`}</div>
      ${gpus.length > 4 ? `<button class="node-expand" data-focus-key="expand:${escapeHtml(node.id)}" data-expand="${escapeHtml(node.id)}">${expanded ? '收起显卡' : `查看全部 ${gpus.length} 张显卡`}${icon('chevron')}</button>` : '<div class="node-caption">已展示全部显卡</div>'}
    </section>`;
  }

  function renderNodes() {
    const selected = state.nodes.filter((node) => state.nodeFilter === 'all' || node.id === state.nodeFilter);
    let count = 0;
    const visible = selected.map((node) => {
      let gpus = node.gpus.filter((gpu) => gpuMatches(node, gpu));
      if (state.sort === 'utilization') gpus.sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1));
      else if (state.sort === 'memory') gpus.sort((a, b) => (b.memoryUsedMb ?? -1) - (a.memoryUsedMb ?? -1));
      else gpus.sort((a, b) => a.index - b.index);
      count += gpus.length;
      if (!gpus.length && (state.search || state.statusFilter !== 'all')) return '';
      return nodeCard(node, gpus);
    }).filter(Boolean);
    $('node-count').textContent = visible.length;
    $('gpu-count').textContent = count;
    const grid = $('node-grid');
    const focusKey = grid.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    const waiting = !state.received || state.collecting || !state.nodes.length;
    grid.innerHTML = visible.join('') || `<div class="empty-state"><span class="empty-icon">${icon(waiting ? 'server' : 'search')}</span><strong>${waiting ? '等待服务器数据' : '没有匹配的显卡'}</strong><p>${waiting ? '连接成功并完成首次采样后，节点会显示在这里。' : '试试其他关键词，或调整节点与状态筛选。'}</p></div>`;
    if (focusKey) [...grid.querySelectorAll('[data-focus-key]')].find((element) => element.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  }

  function renderProcesses() {
    const processes = allProcesses().filter((process) => {
      if (state.nodeFilter !== 'all' && process.node.id !== state.nodeFilter) return false;
      if (!state.search) return true;
      return processMatches(process) || `${process.node.name} ${process.node.host} ${process.gpus.map((index) => `GPU ${index}`).join(' ')}`.toLowerCase().includes(state.search);
    }).sort((a, b) => (b.memoryMb ?? -1) - (a.memoryMb ?? -1));
    $('process-count').textContent = `${processes.length} 个进程`;
    $('process-table-body').innerHTML = processes.map((process) => `<tr><td><div class="user-cell">${avatar(process.user)}<strong>${escapeHtml(process.user)}</strong></div></td><td><div class="table-process"><strong title="${escapeHtml(process.command)}">${escapeHtml(process.name)}</strong><span>PID ${escapeHtml(process.pid ?? '—')}</span></div></td><td><div class="table-node"><strong>${escapeHtml(process.node.name)}</strong><span>GPU ${process.gpus.join(', ')}</span></div></td><td class="table-memory">${gb(process.memoryMb)} <small>GB</small></td><td class="data-muted">${duration(process.elapsedSeconds)}</td><td><button class="table-action" data-detail-node="${escapeHtml(process.node.id)}" data-detail-gpu="${process.gpus[0]}" aria-label="查看 ${escapeHtml(process.node.name)} GPU ${process.gpus[0]}">查看 GPU ${icon('arrow')}</button></td></tr>`).join('') || `<tr><td colspan="6"><div class="empty-state">${state.search ? '没有匹配的计算进程' : '暂无 GPU 计算进程'}</div></td></tr>`;
  }

  function currentAlerts() {
    const alerts = [];
    state.nodes.forEach((node) => {
      if (node.status !== 'online') alerts.push({ node, title: `${node.name} 节点离线`, description: '无法获取节点资源状态，请检查采集程序与网络连接。', type: 'offline' });
      node.gpus.forEach((gpu) => {
        if ((gpu.temperature ?? 0) >= 80) alerts.push({ node, gpu, title: `${node.name} · GPU ${gpu.index} 温度偏高`, description: `当前温度 ${pretty(gpu.temperature)}°C，已达到 80°C 告警阈值。`, type: 'temperature' });
        const ratio = memoryRatio(gpu);
        if (ratio !== null && ratio >= 90) alerts.push({ node, gpu, title: `${node.name} · GPU ${gpu.index} 显存紧张`, description: `已使用 ${gb(gpu.memoryUsedMb)} / ${gb(gpu.memoryTotalMb, 0)} GB 显存（${percent(ratio)}）。`, type: 'memory' });
      });
    });
    return alerts;
  }

  function renderAlerts() {
    const alerts = currentAlerts();
    $('alert-count').textContent = alerts.length;
    if ($('nav-alert-count')) { $('nav-alert-count').textContent = alerts.length; $('nav-alert-count').classList.toggle('has-alert', alerts.length > 0); }
    const incomplete = !state.received || state.collecting || !state.nodes.length;
    $('alert-list').innerHTML = alerts.map((alert) => `<article class="alert-card"><span class="alert-icon">${icon(alert.type === 'temperature' ? 'thermometer' : alert.type === 'memory' ? 'memory' : 'server')}</span><div class="alert-text"><h3>${escapeHtml(alert.title)}</h3><p>${escapeHtml(alert.description)}</p><span>${state.mode === 'demo' ? '演示数据' : '本次采样'} · ${escapeHtml(new Date(state.timestamp).toLocaleTimeString('zh-CN', { hour12: false }))}</span></div><button class="alert-action" ${alert.gpu ? `data-detail-node="${escapeHtml(alert.node.id)}" data-detail-gpu="${alert.gpu.index}"` : `data-show-node="${escapeHtml(alert.node.id)}"`}>查看${icon('arrow')}</button></article>`).join('') || `<div class="empty-state"><span class="empty-icon ${incomplete ? '' : 'success'}">${icon(incomplete ? 'clock' : 'check')}</span><strong>${incomplete ? '等待首次资源采样' : dataWarning() || state.error ? '监控数据需要检查' : '当前资源状态正常'}</strong><p>${incomplete ? '接收到服务器节点数据后，将自动检查资源告警。' : dataWarning() || state.error ? '暂无阈值告警；请先检查页面上方的采集提示。' : '暂未发现温度、显存或节点离线告警。'}</p></div>`;
  }

  function dataWarning() {
    if (state.mode !== 'live' || !state.received) return '';
    if (state.collecting || !state.nodes.length) return state.warnings.join(' · ') || '采集器正在初始化，等待首次节点采样。';
    if (Date.now() - Date.parse(state.timestamp) > state.maxAgeMs) return '采集数据已过期，请检查服务器采集程序。当前保留最后观测值。';
    if (Date.parse(state.timestamp) - Date.now() > 60000) return '服务器采样时间超前，请检查服务器时钟是否正确。';
    const stale = state.nodes.filter((node) => node.status !== 'online' || node.stale).length;
    if (stale) return `${stale} 个节点离线或数据过期，面板包含其最后观测值，请留意节点上的采样时间。`;
    if (state.warnings.length) return state.warnings.join(' · ');
    if (state.nodes.some((node) => node.warnings?.length)) return '部分监控指标不可用，详见节点卡片中的采集提示。';
    return '';
  }

  function renderStatus() {
    const failed = Boolean(state.error);
    const warning = dataWarning();
    $('mode-badge').textContent = state.mode === 'demo' ? '演示模式' : '实时模式';
    $('mode-badge').className = `mode-badge ${state.mode}`;
    $('connection-status').textContent = state.paused ? '已暂停自动刷新' : failed ? '数据连接异常' : warning ? '已连接 · 存在采集提示' : state.mode === 'demo' ? '演示数据更新中' : state.received ? '实时连接正常' : '正在连接服务器';
    $('connection-status').parentElement.classList.toggle('is-error', failed || Boolean(warning));
    const notice = $('data-notice');
    notice.classList.toggle('is-error', failed || Boolean(warning));
    notice.classList.toggle('is-live', state.mode === 'live' && !failed && !warning);
    let message;
    if (failed) message = `${state.error}${state.received ? ' 当前保留最后一次成功采样，请留意更新时间。' : ''}`;
    else if (warning) message = warning;
    else if (state.mode === 'demo') message = '正在展示模拟集群数据。连接服务器后，即可查看真实监控指标。';
    else if (!state.received) message = '正在等待服务器首次采样，监控指标将自动更新。';
    else message = `已连接真实监控接口${state.paused ? '，自动刷新已暂停。' : `，每 ${state.interval / 1000} 秒采样一次。`}`;
    notice.innerHTML = `${icon(failed ? 'info' : state.mode === 'live' ? 'check' : 'info')}<span>${escapeHtml(message)}</span>`;
    $('last-updated').textContent = state.timestamp ? `最后更新 ${new Date(state.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}${state.mode === 'demo' ? ' · 演示数据' : ''}` : '等待首次更新';
    $('pause-btn').innerHTML = `${icon(state.paused ? 'play' : 'pause')}${state.paused ? '继续' : '暂停'}`;
    $('pause-btn').setAttribute('aria-pressed', String(state.paused));
    $('refresh-btn').classList.toggle('refreshing', state.busy);
    $('refresh-btn').disabled = state.busy;
  }

  function syncNodeFilter() {
    const filter = $('node-filter');
    const options = `<option value="all">全部节点</option>${state.nodes.map((node) => `<option value="${escapeHtml(node.id)}">${escapeHtml(node.name)}</option>`).join('')}`;
    if (filter.innerHTML !== options) filter.innerHTML = options;
    if (!state.nodes.some((node) => node.id === state.nodeFilter)) state.nodeFilter = 'all';
    filter.value = state.nodeFilter;
  }

  function render() {
    syncNodeFilter(); renderStats(); renderNodes(); renderProcesses(); renderAlerts(); renderStatus();
    if (state.detail && $('detail-dialog').open) renderDetail();
  }

  function switchView(view) {
    state.view = view;
    const titles = { overview: ['集群概览', '让每一份算力，清晰可见。实时掌握 GPU 与进程的运行状态。'], processes: ['进程管理', '谁在使用算力？查看计算进程、所属用户与显存分配。'], alerts: ['资源告警', '及时发现温度、显存与节点连接异常。'] };
    document.querySelectorAll('[data-view]').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === view);
      if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    Object.keys(titles).forEach((name) => { $(`${name}-view`).hidden = name !== view; });
    $('page-title').textContent = titles[view][0]; $('page-subtitle').textContent = titles[view][1];
  }

  function renderDetail() {
    const node = state.nodes.find((item) => item.id === state.detail?.nodeId);
    const gpu = node?.gpus.find((item) => item.index === state.detail?.index);
    if (!node || !gpu) { $('detail-content').innerHTML = '<div class="empty-state">该显卡暂时不在当前数据中。</div>'; return; }
    $('detail-title').textContent = `${node.name} · GPU ${gpu.index}`;
    $('detail-content').innerHTML = `<p class="detail-meta">${escapeHtml(gpu.name)}<br><span>${escapeHtml(gpu.uuid)}</span></p><div class="detail-grid"><div class="detail-metric"><span>GPU 利用率</span><strong>${percent(gpu.utilization)}</strong></div><div class="detail-metric"><span>显存占用</span><strong>${gb(gpu.memoryUsedMb)} <small>/ ${gb(gpu.memoryTotalMb, 0)} GB</small></strong></div><div class="detail-metric"><span>温度</span><strong>${pretty(gpu.temperature)}<small> °C</small></strong></div><div class="detail-metric"><span>功耗</span><strong>${pretty(gpu.powerWatts)}<small> W</small></strong></div></div><h3 class="detail-section-title">计算进程 <small>${gpu.processes.length}</small></h3><div class="table-container"><table class="detail-table"><thead><tr><th>用户 / PID</th><th>进程</th><th>显存</th><th>运行时长</th></tr></thead><tbody>${gpu.processes.map((process) => `<tr><td><div class="user-cell">${avatar(process.user)}<div class="table-process"><strong>${escapeHtml(process.user)}</strong><span>PID ${escapeHtml(process.pid ?? '—')}</span></div></div></td><td><div class="table-process"><strong>${escapeHtml(process.name)}</strong><span class="detail-command" title="${escapeHtml(process.command)}">${escapeHtml(process.command)}</span></div></td><td>${gb(process.memoryMb)} GB</td><td>${duration(process.elapsedSeconds)}</td></tr>`).join('') || '<tr><td colspan="4"><div class="empty-state">暂无可见的 GPU 计算进程</div></td></tr>'}</tbody></table></div><p class="field-hint">${state.mode === 'demo' ? '当前为模拟演示数据。' : '进程信息来自服务器采集程序，仅展示当前权限下可读取的信息。'}${state.paused ? ' 自动刷新已暂停。' : ''}</p>`;
  }

  function openDetail(nodeId, index) {
    state.detail = { nodeId, index: Number(index) }; renderDetail();
    if (!$('detail-dialog').open) $('detail-dialog').showModal();
  }

  let toastTimer;
  function toast(message) {
    clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200);
  }

  function stopPolling() {
    clearTimeout(state.timer); state.timer = null;
    state.generation += 1;
    state.abort?.abort(); state.abort = null; state.busy = false;
  }

  async function requestMetrics(signal) {
    const options = {
      headers: { Accept: 'application/json' }, signal,
      cache: 'no-store', credentials: 'omit', redirect: 'error'
    };
    let url = state.endpoint;
    if (transport === 'viewer') {
      url = '/api/connect';
      options.method = 'POST';
      options.mode = 'same-origin';
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify({ endpoint: state.endpoint, token: state.token });
    } else if (state.token) {
      options.headers.Authorization = `Bearer ${state.token}`;
    }
    const response = await fetch(url, options);
    if (response.ok) return response.json();
    if (transport === 'viewer') {
      const body = await response.json().catch(() => null);
      if (typeof body?.error === 'string' && body.error) throw new Error(body.error);
      throw new Error(`本机查看器返回 HTTP ${response.status}，请检查查看器和采集器的运行状态。`);
    }
    if (response.status === 401 || response.status === 403) throw new Error('访问被拒绝，请检查访问令牌和允许的来源配置。');
    throw new Error(`监控接口返回 HTTP ${response.status}，请检查采集程序。`);
  }

  async function sample() {
    if (state.busy) return false;
    const generation = state.generation;
    state.busy = true; renderStatus();
    let timeout;
    try {
      let data;
      if (state.mode === 'demo') data = demoSnapshot();
      else {
        const controller = new AbortController();
        state.abort = controller;
        timeout = setTimeout(() => controller.abort(), 9000);
        data = await requestMetrics(controller.signal);
      }
      if (generation !== state.generation) return false;
      const payload = validateSnapshot(data);
      state.nodes = payload.nodes; state.timestamp = payload.timestamp; state.received = true; state.error = ''; state.warnings = payload.warnings || []; state.collecting = payload.collecting; state.maxAgeMs = payload.maxAgeMs;
      if (state.nodes.length && !state.collecting) updateHistory();
      render();
      return true;
    } catch (error) {
      if (generation !== state.generation) return false;
      if (error.name === 'AbortError') state.error = '服务器响应超时，请检查网络或采集程序。';
      else if (error instanceof TypeError) state.error = transport === 'viewer'
        ? '无法连接本机查看器，请确认 viewer.py 正在运行。'
        : '无法连接监控接口，请检查地址、HTTPS 和跨域配置。';
      else state.error = error.message || '暂时无法读取监控数据。';
      render(); return false;
    } finally {
      clearTimeout(timeout);
      if (generation === state.generation) { state.busy = false; state.abort = null; renderStatus(); }
    }
  }

  async function poll() {
    clearTimeout(state.timer);
    const generation = state.generation;
    const success = await sample();
    if (generation === state.generation && !state.paused) state.timer = setTimeout(poll, state.interval);
    return success;
  }

  function connectionModeChanged() {
    const live = $('connection-mode').value === 'live';
    $('endpoint-input').disabled = !live; $('token-input').disabled = !live; $('endpoint-input').required = live;
    $('connection-error').hidden = true;
  }

  function openConnection() {
    const version = ++connectionDialogVersion;
    $('connection-mode').value = state.mode === 'demo' ? 'live' : state.mode;
    $('endpoint-input').value = state.endpoint || (transport === 'direct' ? directEndpoint : '');
    $('token-input').value = state.token;
    connectionModeChanged(); $('connection-dialog').showModal();
    viewerReady.then(() => {
      if (version !== connectionDialogVersion || !$('connection-dialog').open) return;
      const input = $('endpoint-input');
      if (transport === 'direct' && !input.value) input.value = directEndpoint;
      if (transport === 'viewer' && !state.endpoint && input.value === directEndpoint) input.value = '';
    });
  }

  function normalizeEndpoint(value) {
    let url;
    try { url = new URL(value.trim()); } catch { throw new Error('请输入有效的 HTTP 或 HTTPS 接口地址。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('接口地址需使用 HTTP 或 HTTPS；请通过令牌字段验证身份。');
    if (transport === 'viewer' && /[?#]/.test(url.href)) throw new Error('采集器地址不能包含查询参数或片段。请在令牌字段中填写访问令牌。');
    if (transport !== 'viewer' && location.protocol === 'https:' && url.protocol === 'http:' && !loopbackHosts.includes(url.hostname)) throw new Error('当前页面使用 HTTPS，请为远程监控接口配置 HTTPS。');
    if (url.pathname === '/') url.pathname = '/api/metrics';
    if (transport === 'viewer' && url.origin === location.origin) throw new Error('请填写 Linux 采集器的地址，包括 SSH 隧道转发的采集端口。');
    url.hash = ''; return url.href;
  }

  function rememberEndpoint(endpoint) {
    try {
      // A legacy direct endpoint may include a query parameter. Keep it in memory only.
      if (/[?#]/.test(endpoint)) localStorage.removeItem(endpointKey);
      else localStorage.setItem(endpointKey, endpoint);
    } catch { /* Storage may be disabled. */ }
  }

  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('search-input').addEventListener('input', (event) => { state.search = event.target.value.trim().toLowerCase(); renderNodes(); renderProcesses(); });
  $('node-filter').addEventListener('change', (event) => { state.nodeFilter = event.target.value; renderNodes(); renderProcesses(); });
  $('status-filter').addEventListener('change', (event) => { state.statusFilter = event.target.value; renderNodes(); });
  $('sort-select').addEventListener('change', (event) => { state.sort = event.target.value; renderNodes(); });
  $('interval-select').addEventListener('change', (event) => {
    state.interval = Number(event.target.value); clearTimeout(state.timer);
    if (!state.paused && !state.busy) state.timer = setTimeout(poll, state.interval);
    renderStatus(); toast(`刷新间隔已设为 ${state.interval / 1000} 秒`);
  });
  $('pause-btn').addEventListener('click', () => {
    state.paused = !state.paused;
    if (state.paused) stopPolling(); else poll();
    renderStatus();
  });
  $('refresh-btn').addEventListener('click', async () => {
    if (state.busy) return;
    const success = await poll();
    if (success) toast(state.mode === 'demo' ? '演示数据已刷新' : '监控数据已刷新');
  });
  $('node-grid').addEventListener('click', (event) => {
    const expand = event.target.closest('[data-expand]');
    if (expand) { const id = expand.dataset.expand; state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id); renderNodes(); return; }
    const card = event.target.closest('[data-detail-node]');
    if (card) openDetail(card.dataset.detailNode, card.dataset.detailGpu);
  });
  $('node-grid').addEventListener('keydown', (event) => {
    if (event.target.matches('.gpu-card') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); openDetail(event.target.dataset.detailNode, event.target.dataset.detailGpu); }
  });
  [$('process-table-body'), $('alert-list')].forEach((element) => element.addEventListener('click', (event) => {
    const detail = event.target.closest('[data-detail-node]');
    if (detail) { openDetail(detail.dataset.detailNode, detail.dataset.detailGpu); return; }
    const node = event.target.closest('[data-show-node]');
    if (node) { state.nodeFilter = node.dataset.showNode; syncNodeFilter(); switchView('overview'); renderNodes(); }
  }));
  $('connect-btn').addEventListener('click', openConnection); $('sidebar-connect-btn').addEventListener('click', openConnection);
  [$('close-dialog'), $('cancel-connection')].forEach((button) => button.addEventListener('click', () => $('connection-dialog').close()));
  $('close-detail').addEventListener('click', () => $('detail-dialog').close());
  $('connection-mode').addEventListener('change', connectionModeChanged);
  $('connection-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('connection-form').querySelector('[type="submit"]');
    if (submit.disabled) return;
    submit.disabled = true;
    $('connection-error').hidden = true;
    const mode = $('connection-mode').value;
    const address = $('endpoint-input').value;
    const token = $('token-input').value.trim();
    const dialog = $('connection-dialog');
    const version = connectionDialogVersion;
    try {
      let endpoint = state.endpoint;
      if (mode === 'live') {
        await viewerReady;
        if (!dialog.open || version !== connectionDialogVersion) return;
        if (transport === 'unavailable') throw new Error('无法确认本机查看服务。请检查该服务后刷新页面。');
        endpoint = normalizeEndpoint(address);
      }
      const reset = mode !== state.mode || endpoint !== state.endpoint;
      stopPolling();
      state.mode = mode;
      state.endpoint = endpoint;
      state.token = mode === 'live' ? token : '';
      state.error = '';
      if (reset) {
        state.nodes = [];
        state.timestamp = null;
        state.received = false;
        state.history = [];
        state.expanded.clear();
        state.detail = null;
        state.warnings = [];
        state.collecting = false;
      }
      if (mode === 'live') rememberEndpoint(endpoint);
      render();
      const success = await poll();
      if (version !== connectionDialogVersion || !dialog.open) return;
      if (success) {
        dialog.close();
        toast(mode === 'demo' ? '已切换到演示模式' : dataWarning() ? '已连接，请查看采集提示' : '服务器已连接');
      } else if (state.error) throw new Error(state.error);
    } catch (error) {
      $('connection-error').textContent = error.message;
      $('connection-error').hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !document.querySelector('dialog[open]')) { event.preventDefault(); $('search-input').focus(); }
  });
  window.addEventListener('pagehide', () => stopPolling());
  switchView('overview'); render(); poll();
  viewerReady = detectTransport().then((detected) => {
    transport = detected;
    if (transport === 'viewer' && state.endpoint === directEndpoint) state.endpoint = '';
    $('local-viewer-tip').hidden = transport !== 'viewer';
  });
})();
