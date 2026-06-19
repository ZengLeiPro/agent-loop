const statusEl = document.querySelector('#status');
const statusSummaryEl = document.querySelector('#statusSummary');
const phaseTimelineEl = document.querySelector('#phaseTimeline');
const promptEl = document.querySelector('#prompt');
const autopilotLevelEl = document.querySelector('#autopilotLevel');
const autopilotMappingEl = document.querySelector('#autopilotMapping');
const dryRunEl = document.querySelector('#dryRun');
const plannerOnlyEl = document.querySelector('#plannerOnly');
const maxRoundsEl = document.querySelector('#maxRounds');
const maxTurnsEl = document.querySelector('#maxTurns');
const permissionModeEl = document.querySelector('#permissionMode');
const plannerModelEl = document.querySelector('#plannerModel');
const workerModelEl = document.querySelector('#workerModel');
const judgeModelEl = document.querySelector('#judgeModel');
const apiEndpointEl = document.querySelector('#apiEndpoint');
const apiKeyEl = document.querySelector('#apiKey');
const effortEl = document.querySelector('#effort');
const maxThinkingTokensEl = document.querySelector('#maxThinkingTokens');
const refreshButton = document.querySelector('#refresh');
const createButton = document.querySelector('#create');
const loadPromptsButton = document.querySelector('#loadPrompts');
const savePromptsButton = document.querySelector('#savePrompts');
const loadReviewButton = document.querySelector('#loadReview');
const saveReviewButton = document.querySelector('#saveReview');
const resumeRunButton = document.querySelector('#resumeRun');
const pauseRunButton = document.querySelector('#pauseRun');
const controlResumeRunButton = document.querySelector('#controlResumeRun');
const cancelRunButton = document.querySelector('#cancelRun');
const retryJudgeButton = document.querySelector('#retryJudge');
const clearEventsButton = document.querySelector('#clearEvents');
const refreshArtifactsButton = document.querySelector('#refreshArtifacts');
const reviewSpecEl = document.querySelector('#reviewSpec');
const reviewPrdEl = document.querySelector('#reviewPrd');
const prdSummaryEl = document.querySelector('#prdSummary');
const prdStoriesEl = document.querySelector('#prdStories');
const liveEventsEl = document.querySelector('#liveEvents');
const eventsConnectionEl = document.querySelector('#eventsConnection');
const qualityGateEl = document.querySelector('#qualityGate');
const changesEvidenceEl = document.querySelector('#changesEvidence');
const toastRegionEl = document.querySelector('#toastRegion');

const pageViews = [...document.querySelectorAll('[data-page]')];
const pageNavLinks = [...document.querySelectorAll('[data-nav-page]')];
const PAGE_TITLES = {
  launch: 'Launch',
  monitor: 'Monitor',
  events: 'Events',
  quality: 'Quality',
  debug: 'Debug',
  review: 'Review',
  prompts: 'Prompts'
};
const DEFAULT_PAGE = 'launch';

function pageFromPath(pathname = window.location.pathname) {
  const page = pathname.replace(/^\//, '') || DEFAULT_PAGE;
  return pageViews.some(view => view.dataset.page === page) ? page : DEFAULT_PAGE;
}

function showPage(page, { replace = false } = {}) {
  const nextPage = pageViews.some(view => view.dataset.page === page) ? page : DEFAULT_PAGE;
  for (const view of pageViews) {
    const active = view.dataset.page === nextPage;
    view.classList.toggle('is-active', active);
    view.toggleAttribute('hidden', !active);
  }
  for (const link of pageNavLinks) {
    const active = link.dataset.navPage === nextPage;
    link.classList.toggle('is-active', active);
    link.setAttribute('aria-current', active ? 'page' : 'false');
  }
  document.title = `${PAGE_TITLES[nextPage]} · agent-loop 控制台`;
  const nextPath = nextPage === DEFAULT_PAGE ? '/' : `/${nextPage}`;
  if (window.location.pathname !== nextPath) {
    window.history[replace ? 'replaceState' : 'pushState']({ page: nextPage }, '', nextPath);
  }
}

function setupPageNavigation() {
  for (const link of pageNavLinks) {
    link.addEventListener('click', event => {
      event.preventDefault();
      showPage(link.dataset.navPage);
    });
  }
  window.addEventListener('popstate', () => showPage(pageFromPath(), { replace: true }));
  showPage(pageFromPath(), { replace: true });
}

const AUTO_REFRESH_STATUSES = new Set(['waiting-for-agent-adapter', 'running']);
const SAFE_CLASS_TOKEN = /^[a-z0-9_-]+$/i;
const STATUS_LABELS = {
  initialized: '已初始化',
  planned: '已规划',
  'waiting-for-agent-adapter': '等待 Agent',
  running: '运行中',
  paused: '已暂停',
  cancelled: '已取消',
  canceled: '已取消',
  'waiting-for-review': '等待人工检查',
  completed: '已完成',
  failed: '失败',
  max_rounds_reached: '达到最大轮数'
};
const ROLE_LABELS = { planner: 'Planner', worker: 'Worker', judge: 'Judge' };
const AUTOPILOT_LEVELS = {
  preview: {
    label: 'Level 0 · Preview',
    dryRun: true,
    plannerOnly: false,
    permissionMode: 'acceptEdits',
    description: '只写入本地状态，适合确认任务配置，不调用 SDK。'
  },
  review: {
    label: 'Level 1 · Review',
    dryRun: false,
    plannerOnly: true,
    permissionMode: 'plan',
    description: '执行 Planner 后停在人工审查点，优先安全规划。'
  },
  guarded: {
    label: 'Level 2 · Guarded',
    dryRun: false,
    plannerOnly: false,
    permissionMode: 'acceptEdits',
    description: '默认自动化：运行完整循环并自动接受文件编辑。'
  },
  auto: {
    label: 'Level 3 · Auto',
    dryRun: false,
    plannerOnly: false,
    permissionMode: 'auto',
    description: '交给模型/SDK 权限分类器判断，适合中等信任场景。'
  },
  yolo: {
    label: 'Level 4 · YOLO',
    dryRun: false,
    plannerOnly: false,
    permissionMode: 'bypassPermissions',
    description: '跳过权限检查，仅限可信本地仓库和可回滚环境。'
  }
};

let refreshTimer;
let eventSource;
let eventPollingTimer;
let lastStatusData;
let syntheticEventKey = '';
const seenEventKeys = new Set();

const promptFields = {
  systemPrompts: {
    planner: document.querySelector('#plannerSystemPrompt'),
    worker: document.querySelector('#workerSystemPrompt'),
    judge: document.querySelector('#judgeSystemPrompt')
  },
  phasePrompts: {
    planner: document.querySelector('#plannerPhasePrompt'),
    worker: document.querySelector('#workerPhasePrompt'),
    judge: document.querySelector('#judgePhasePrompt')
  }
};

function optionalNumber(input) {
  const value = input.value.trim();
  return value === '' ? undefined : Number(value);
}

function optionalString(input) {
  const value = input.value.trim();
  return value === '' ? undefined : value;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN');
}

function classToken(value, fallback = 'unknown') {
  const token = String(value || fallback);
  return SAFE_CLASS_TOKEN.test(token) ? token : fallback;
}

function formatDuration(startedAt, completedAt) {
  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—';
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || '未知';
}

function phaseLabel(phase) {
  const role = ROLE_LABELS[phase.role] || phase.role || 'Phase';
  return phase.round ? `${role} · Round ${phase.round}` : role;
}

function latestPhase(run) {
  return run?.phases?.at(-1);
}

function latestError(run) {
  return [...(run?.phases || [])].reverse().find(phase => phase.error)?.error;
}

function currentPhaseText(run) {
  const running = [...(run?.phases || [])].reverse().find(phase => phase.status === 'running');
  const phase = running || latestPhase(run);
  return phase ? phaseLabel(phase) : '—';
}

function shouldAutoRefresh(run) {
  return AUTO_REFRESH_STATUSES.has(run?.status);
}

function setAutoRefresh(run) {
  clearInterval(refreshTimer);
  if (shouldAutoRefresh(run)) {
    refreshTimer = setInterval(() => refresh().catch(renderError), 2500);
  }
}

function showToast(message, variant = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${classToken(variant)}`;
  toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');
  toast.innerHTML = `<strong>${escapeHtml(message)}</strong>`;
  toastRegionEl.append(toast);
  setTimeout(() => toast.classList.add('toast-visible'), 20);
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 4200);
}

function renderEmptyStatus(data) {
  statusSummaryEl.innerHTML = `
    <div class="empty-state">
      <strong>还没有运行状态。</strong>
      <span>当前目录：<code>${escapeHtml(data.cwd)}</code></span>
      <span>状态目录：<code>${escapeHtml(data.stateDir)}</code></span>
      <span>先创建 dry run 预览配置，或关闭 dry run 启动真实 Planner → Worker → Judge 循环。</span>
    </div>
  `;
  phaseTimelineEl.innerHTML = '';
}

function renderSummary(data) {
  const run = data.run;
  if (!run) {
    renderEmptyStatus(data);
    return;
  }

  const error = latestError(run);
  const badgeClass = `status-badge status-${classToken(run.status)}`;
  statusSummaryEl.innerHTML = `
    <div class="run-header">
      <div>
        <span class="${badgeClass}">${escapeHtml(statusLabel(run.status))}</span>
        <h3>${escapeHtml(run.id || '未命名运行')}</h3>
      </div>
      <div class="run-round">Round ${escapeHtml(run.currentRound ?? 0)} / ${escapeHtml(run.maxRounds ?? '—')}</div>
    </div>
    <div class="summary-grid">
      <div><span>项目目录</span><strong><code>${escapeHtml(data.cwd || '—')}</code></strong></div>
      <div><span>状态目录</span><strong><code>${escapeHtml(data.stateDir || '—')}</code></strong></div>
      <div><span>当前阶段</span><strong>${escapeHtml(currentPhaseText(run))}</strong></div>
      <div><span>创建时间</span><strong>${escapeHtml(formatDate(run.createdAt))}</strong></div>
      <div><span>更新时间</span><strong>${escapeHtml(formatDate(run.updatedAt))}</strong></div>
      <div><span>权限模式</span><strong>${escapeHtml(run.permissionMode || '—')}</strong></div>
      <div><span>最大 turns</span><strong>${escapeHtml(run.maxTurns ?? '—')}</strong></div>
      <div><span>Planner 后暂停</span><strong>${run.plannerOnly ? '是' : '否'}</strong></div>
    </div>
    <div class="prompt-preview"><span>任务</span><p>${escapeHtml(run.prompt || '—')}</p></div>
    ${error ? `<div class="error-card"><strong>最近错误</strong><p>${escapeHtml(error)}</p></div>` : ''}
  `;
}

function renderTimeline(run) {
  const phases = run?.phases || [];
  if (phases.length === 0) {
    phaseTimelineEl.innerHTML = '<p class="hint">暂无 phase 记录。</p>';
    return;
  }

  phaseTimelineEl.innerHTML = `
    <h3>阶段时间线</h3>
    <ol class="timeline-list">
      ${phases.map(phase => `
        <li class="phase-card phase-${classToken(phase.status)}">
          <div class="phase-main">
            <span class="phase-role">${escapeHtml(phaseLabel(phase))}</span>
            <span class="phase-status">${escapeHtml(statusLabel(phase.status))}</span>
          </div>
          <div class="phase-meta">
            <span>开始：${escapeHtml(formatDate(phase.startedAt))}</span>
            <span>完成：${escapeHtml(formatDate(phase.completedAt))}</span>
            <span>耗时：${escapeHtml(formatDuration(phase.startedAt, phase.completedAt))}</span>
            ${phase.sessionId ? `<span>Session：<code>${escapeHtml(phase.sessionId)}</code></span>` : ''}
            ${typeof phase.totalCostUsd === 'number' ? `<span>成本：$${escapeHtml(phase.totalCostUsd.toFixed(4))}</span>` : ''}
          </div>
          ${phase.note ? `<p class="phase-note">${escapeHtml(phase.note)}</p>` : ''}
          ${phase.error ? `<p class="phase-error">${escapeHtml(phase.error)}</p>` : ''}
        </li>
      `).join('')}
    </ol>
  `;
}

function updateRunControls(run) {
  const hasRun = Boolean(run);
  const isActive = AUTO_REFRESH_STATUSES.has(run?.status);
  pauseRunButton.disabled = !hasRun || !isActive;
  cancelRunButton.disabled = !hasRun || ['completed', 'failed', 'cancelled', 'canceled'].includes(run?.status);
  controlResumeRunButton.disabled = !hasRun || !['paused', 'waiting-for-review'].includes(run?.status);
  retryJudgeButton.disabled = !hasRun;
  resumeRunButton.disabled = run?.status !== 'waiting-for-review';
}

function renderStatus(data) {
  lastStatusData = data;
  statusEl.textContent = JSON.stringify(data, null, 2);
  renderSummary(data);
  renderTimeline(data.run);
  updateRunControls(data.run);
  setAutoRefresh(data.run);
  renderSyntheticEvents(data.run);
  refreshArtifacts({ silent: true }).catch(() => {});
}

function renderError(error) {
  const message = error instanceof Error ? error.message : String(error);
  statusSummaryEl.innerHTML = `<div class="error-card"><strong>请求失败</strong><p>${escapeHtml(message)}</p></div>`;
  statusEl.textContent = message;
  showToast(message, 'error');
}

async function readJson(response) {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`请求失败：${response.status}，响应不是有效 JSON。`);
  }
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

async function readOptionalJson(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 404 || response.status === 405) return { unavailable: true, status: response.status };
  return { data: await readJson(response) };
}

async function refresh() {
  const response = await fetch('/api/status');
  renderStatus(await readJson(response));
}

function applyAutopilotLevel(level) {
  const config = AUTOPILOT_LEVELS[level];
  if (!config) return renderAutopilotMapping();
  dryRunEl.checked = config.dryRun;
  plannerOnlyEl.checked = config.plannerOnly;
  permissionModeEl.value = config.permissionMode;
  renderAutopilotMapping();
}

function maybeMarkCustomAutopilot() {
  const match = Object.entries(AUTOPILOT_LEVELS).find(([, config]) => (
    config.dryRun === dryRunEl.checked
    && config.plannerOnly === plannerOnlyEl.checked
    && config.permissionMode === permissionModeEl.value
  ));
  autopilotLevelEl.value = match?.[0] || 'custom';
  renderAutopilotMapping();
}

function renderAutopilotMapping() {
  const level = autopilotLevelEl.value;
  const config = AUTOPILOT_LEVELS[level];
  const label = config?.label || 'Custom';
  const description = config?.description || '正在使用手动覆盖参数；提交时仍按当前 dryRun / plannerOnly / permissionMode 字段发送。';
  autopilotMappingEl.innerHTML = `
    <strong>${escapeHtml(label)}</strong>
    <span>${escapeHtml(description)}</span>
    <code>dryRun=${dryRunEl.checked}</code>
    <code>plannerOnly=${plannerOnlyEl.checked}</code>
    <code>permissionMode=${escapeHtml(permissionModeEl.value || '—')}</code>
  `;
}

function normalizeEvent(raw, source = 'event') {
  const event = typeof raw === 'object' && raw !== null ? raw : { message: raw };
  return {
    type: event.type || event.event || event.phase || source,
    message: event.message || event.note || event.text || event.status || JSON.stringify(event),
    timestamp: event.timestamp || event.createdAt || event.time || new Date().toISOString(),
    role: event.role,
    round: event.round,
    id: event.id
  };
}

function appendEvent(raw, source) {
  const event = normalizeEvent(raw, source);
  const key = event.id || `${event.timestamp}:${event.type}:${event.role || ''}:${event.round || ''}:${event.message}`;
  if (seenEventKeys.has(key)) return;
  seenEventKeys.add(key);
  const item = document.createElement('div');
  item.className = `event-item event-${classToken(event.type)}`;
  item.innerHTML = `
    <time>${escapeHtml(formatDate(event.timestamp))}</time>
    <strong>${escapeHtml(event.type)}</strong>
    ${event.role || event.round ? `<span>${escapeHtml([event.role, event.round ? `Round ${event.round}` : ''].filter(Boolean).join(' · '))}</span>` : ''}
    <p>${escapeHtml(event.message)}</p>
  `;
  liveEventsEl.prepend(item);
  while (liveEventsEl.children.length > 100) liveEventsEl.lastElementChild.remove();
  while (seenEventKeys.size > 200) seenEventKeys.delete(seenEventKeys.values().next().value);
}

function setEventsConnection(message, variant = 'muted') {
  eventsConnectionEl.textContent = message;
  eventsConnectionEl.dataset.variant = variant;
}

function renderSyntheticEvents(run) {
  const phases = run?.phases || [];
  const key = JSON.stringify(phases.map(phase => [phase.role, phase.round, phase.status, phase.startedAt, phase.completedAt, phase.error]));
  if (!phases.length || key === syntheticEventKey) return;
  syntheticEventKey = key;
  const latest = phases.at(-1);
  appendEvent({
    type: 'status-poll',
    role: latest.role,
    round: latest.round,
    status: statusLabel(latest.status),
    message: `${phaseLabel(latest)}：${statusLabel(latest.status)}`,
    timestamp: latest.completedAt || latest.startedAt || run.updatedAt
  }, 'poll');
}

async function pollEvents() {
  const result = await readOptionalJson('/api/events', { headers: { accept: 'application/json' } });
  if (result.unavailable) {
    setEventsConnection('/api/events 尚未实现，正在从 /api/status 轮询生成摘要事件。', 'warning');
    await refresh();
    return;
  }
  setEventsConnection('正在通过 /api/events 轮询事件。', 'ok');
  const events = Array.isArray(result.data) ? result.data : result.data.events || result.data.items || [];
  for (const event of events.slice(-20)) appendEvent(event, 'poll');
}

function startEventStream() {
  clearInterval(eventPollingTimer);
  if (eventSource) eventSource.close();
  if ('EventSource' in window) {
    eventSource = new EventSource('/api/events');
    eventSource.onopen = () => setEventsConnection('SSE 已连接：/api/events', 'ok');
    eventSource.onmessage = event => {
      try {
        appendEvent(JSON.parse(event.data), 'sse');
      } catch {
        appendEvent(event.data, 'sse');
      }
    };
    eventSource.onerror = () => {
      eventSource.close();
      setEventsConnection('SSE 不可用，切换到 fallback polling。', 'warning');
      eventPollingTimer = setInterval(() => pollEvents().catch(() => {}), 5000);
      pollEvents().catch(() => {});
    };
    return;
  }
  setEventsConnection('当前浏览器不支持 SSE，使用 fallback polling。', 'warning');
  eventPollingTimer = setInterval(() => pollEvents().catch(() => {}), 5000);
  pollEvents().catch(() => {});
}

function collectStories(prd) {
  if (Array.isArray(prd)) return prd;
  if (!prd || typeof prd !== 'object') return [];
  const candidates = [prd.stories, prd.userStories, prd.requirements, prd.items, prd.features, prd.tasks];
  return candidates.find(Array.isArray) || [];
}

function storyValue(story, keys, fallback = '—') {
  if (typeof story === 'string') return keys.includes('title') ? story : fallback;
  for (const key of keys) {
    if (story?.[key] !== undefined && story[key] !== null && story[key] !== '') return story[key];
  }
  return fallback;
}

function renderPrdOverview() {
  const raw = reviewPrdEl.value.trim();
  if (!raw) {
    prdSummaryEl.innerHTML = '<div class="empty-state">PRD 为空，加载或填写 prd.json 后会在这里生成 summary。</div>';
    prdStoriesEl.innerHTML = '';
    return;
  }
  try {
    const prd = JSON.parse(raw);
    const stories = collectStories(prd);
    const title = prd.title || prd.name || prd.product || 'PRD';
    const statuses = stories.reduce((acc, story) => {
      const status = String(storyValue(story, ['status', 'state', 'phase'], 'unknown'));
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    prdSummaryEl.innerHTML = `
      <div class="summary-grid compact-summary">
        <div><span>标题</span><strong>${escapeHtml(title)}</strong></div>
        <div><span>Stories</span><strong>${stories.length}</strong></div>
        <div><span>状态分布</span><strong>${escapeHtml(Object.entries(statuses).map(([key, value]) => `${key}: ${value}`).join(' · ') || '—')}</strong></div>
      </div>
    `;
    if (!stories.length) {
      prdStoriesEl.innerHTML = '<div class="empty-state">未识别到 stories/userStories/requirements/items/features/tasks 数组。</div>';
      return;
    }
    prdStoriesEl.innerHTML = `
      <div class="table-wrap"><table class="stories-table">
        <thead><tr><th>ID</th><th>Story</th><th>Priority</th><th>Status</th><th>Acceptance / Evidence</th></tr></thead>
        <tbody>${stories.map((story, index) => `
          <tr>
            <td>${escapeHtml(storyValue(story, ['id', 'key'], index + 1))}</td>
            <td>${escapeHtml(storyValue(story, ['title', 'story', 'name', 'description']))}</td>
            <td>${escapeHtml(storyValue(story, ['priority', 'severity']))}</td>
            <td><span class="status-badge status-${classToken(storyValue(story, ['status', 'state', 'phase'], 'unknown'))}">${escapeHtml(storyValue(story, ['status', 'state', 'phase'], 'unknown'))}</span></td>
            <td>${escapeHtml(storyValue(story, ['acceptanceCriteria', 'acceptance', 'evidence', 'notes']))}</td>
          </tr>
        `).join('')}</tbody>
      </table></div>
    `;
  } catch (error) {
    prdSummaryEl.innerHTML = `<div class="error-card"><strong>PRD JSON 解析失败</strong><p>${escapeHtml(error.message)}</p></div>`;
    prdStoriesEl.innerHTML = '';
  }
}

function normalizeArtifactPayload(data) {
  return data?.artifacts || data?.evidence || data || {};
}

function renderQualityGate(payload) {
  const artifacts = normalizeArtifactPayload(payload);
  const gate = artifacts.qualityGate || artifacts.quality || artifacts.gate || artifacts.judge || {};
  const verdict = gate.verdict || gate.status || gate.result || artifacts.verdict || 'unknown';
  const checks = gate.checks || artifacts.checks || artifacts.tests || [];
  qualityGateEl.innerHTML = `
    <div class="quality-verdict quality-${classToken(verdict)}">
      <span>Verdict</span><strong>${escapeHtml(verdict)}</strong>
    </div>
    <div class="check-list">
      ${(Array.isArray(checks) ? checks : Object.entries(checks).map(([name, value]) => ({ name, status: value }))).slice(0, 8).map(check => `
        <div class="check-item"><strong>${escapeHtml(check.name || check.label || check.command || 'check')}</strong><span>${escapeHtml(check.status || check.result || check.outcome || check)}</span></div>
      `).join('') || '<div class="empty-state">暂无 Quality Gate check 数据。</div>'}
    </div>
  `;
}

function renderChangesEvidence(payload) {
  const artifacts = normalizeArtifactPayload(payload);
  const changes = artifacts.changes || artifacts.files || artifacts.diff || [];
  const evidence = artifacts.evidence || artifacts.links || artifacts.reports || artifacts.logs || [];
  const list = value => Array.isArray(value) ? value : Object.entries(value || {}).map(([name, detail]) => ({ name, detail }));
  changesEvidenceEl.innerHTML = `
    <div class="evidence-columns">
      <div><h4>Changes</h4>${renderEvidenceList(list(changes), '暂无 changes 数据。')}</div>
      <div><h4>Evidence</h4>${renderEvidenceList(list(evidence), '暂无 evidence 数据。')}</div>
    </div>
  `;
}

function renderEvidenceList(items, emptyText) {
  if (!items.length) return `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
  return `<ul class="evidence-list">${items.slice(0, 12).map(item => `<li><strong>${escapeHtml(item.path || item.file || item.name || item.title || item.type || 'item')}</strong><span>${escapeHtml(item.detail || item.summary || item.status || item.url || item.message || item)}</span></li>`).join('')}</ul>`;
}

async function refreshArtifacts({ silent = false } = {}) {
  if (!silent) {
    refreshArtifactsButton.disabled = true;
    refreshArtifactsButton.textContent = '刷新中…';
  }
  try {
    let result = await readOptionalJson('/api/artifacts');
    if (result.unavailable) result = await readOptionalJson('/api/evidence');
    if (result.unavailable) {
      qualityGateEl.innerHTML = '<div class="empty-state">后端尚未提供 /api/artifacts 或 /api/evidence；区域已就绪，接口补齐后会自动消费。</div>';
      changesEvidenceEl.innerHTML = '';
      if (!silent) showToast('证据接口尚未实现。', 'warning');
      return;
    }
    renderQualityGate(result.data);
    renderChangesEvidence(result.data);
    if (!silent) showToast('证据已刷新。');
  } catch (error) {
    if (!silent) renderError(error);
  } finally {
    if (!silent) {
      refreshArtifactsButton.disabled = false;
      refreshArtifactsButton.textContent = '刷新证据';
    }
  }
}

async function loadPrompts() {
  loadPromptsButton.disabled = true;
  loadPromptsButton.textContent = '加载中…';
  try {
    const response = await fetch('/api/prompts');
    const data = await readJson(response);
    for (const [group, fields] of Object.entries(promptFields)) {
      for (const [key, field] of Object.entries(fields)) {
        field.value = data[group]?.[key] || '';
      }
    }
    if (!lastStatusData) statusEl.textContent = JSON.stringify({ message: '提示语已加载。' }, null, 2);
  } catch (error) {
    renderError(error);
  } finally {
    loadPromptsButton.disabled = false;
    loadPromptsButton.textContent = '重新加载提示语';
  }
}

async function loadReview() {
  loadReviewButton.disabled = true;
  loadReviewButton.textContent = '加载中…';
  try {
    const response = await fetch('/api/review');
    const data = await readJson(response);
    reviewSpecEl.value = data.files?.spec || '';
    reviewPrdEl.value = data.files?.prd || '';
    renderPrdOverview();
  } catch (error) {
    renderError(error);
  } finally {
    loadReviewButton.disabled = false;
    loadReviewButton.textContent = '加载 spec / PRD';
  }
}

async function saveReview() {
  saveReviewButton.disabled = true;
  saveReviewButton.textContent = '保存中…';
  try {
    const response = await fetch('/api/review', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: { spec: reviewSpecEl.value, prd: reviewPrdEl.value } })
    });
    await readJson(response);
    showToast('Planner 产物已保存，可以继续运行。');
  } catch (error) {
    renderError(error);
    throw error;
  } finally {
    saveReviewButton.disabled = false;
    saveReviewButton.textContent = '保存修改';
  }
}

async function resumeRun() {
  resumeRunButton.disabled = true;
  resumeRunButton.textContent = '继续中…';
  try {
    await saveReview();
    const response = await fetch('/api/resume', { method: 'POST' });
    const data = await readJson(response);
    renderStatus({ cwd: lastStatusData?.cwd || '', stateDir: lastStatusData?.stateDir || '', run: data.run });
    showPage('monitor');
  } catch (error) {
    renderError(error);
  } finally {
    resumeRunButton.textContent = '继续运行';
    updateRunControls(lastStatusData?.run);
  }
}

async function callRunControl(action, endpoint, button, controlAction) {
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = '请求中…';
  try {
    let result = await readOptionalJson(endpoint, { method: 'POST' });
    if (result.unavailable && controlAction) {
      result = await readOptionalJson('/api/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: controlAction, reason: 'Requested from Web UI run controls.' })
      });
    }
    if (result.unavailable) {
      showToast(`${action} API 尚未实现，后端补齐后此按钮会直接可用。`, 'warning');
      return;
    }
    if (result.data?.run) renderStatus({ cwd: lastStatusData?.cwd || '', stateDir: lastStatusData?.stateDir || '', run: result.data.run });
    else await refresh();
    showToast(`${action} 请求已发送。`);
  } catch (error) {
    renderError(error);
  } finally {
    button.textContent = originalText;
    updateRunControls(lastStatusData?.run);
  }
}

async function savePrompts() {
  savePromptsButton.disabled = true;
  savePromptsButton.textContent = '保存中…';
  try {
    const payload = { systemPrompts: {}, phasePrompts: {} };
    for (const [group, fields] of Object.entries(promptFields)) {
      for (const [key, field] of Object.entries(fields)) {
        payload[group][key] = field.value;
      }
    }
    const response = await fetch('/api/prompts', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    await readJson(response);
    showToast('提示语已保存，后续运行会立即使用。');
  } catch (error) {
    renderError(error);
  } finally {
    savePromptsButton.disabled = false;
    savePromptsButton.textContent = '保存提示语';
  }
}

async function createRun() {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    renderError(new Error('请先填写任务描述。'));
    promptEl.focus();
    return;
  }

  const dangerousPermission = optionalString(permissionModeEl) === 'bypassPermissions';
  const allowDangerous = dangerousPermission && window.confirm('bypassPermissions 会跳过 SDK 权限检查。请确认当前仓库可信、可回滚，并且你接受本次高风险自动化。');
  if (dangerousPermission && !allowDangerous) {
    showToast('已取消 bypassPermissions 运行。', 'warning');
    return;
  }

  createButton.disabled = true;
  createButton.textContent = '启动中…';
  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        dryRun: dryRunEl.checked,
        plannerOnly: plannerOnlyEl.checked,
        maxRounds: optionalNumber(maxRoundsEl),
        maxTurns: optionalNumber(maxTurnsEl),
        permissionMode: optionalString(permissionModeEl),
        allowDangerous,
        models: {
          planner: optionalString(plannerModelEl),
          worker: optionalString(workerModelEl),
          judge: optionalString(judgeModelEl)
        },
        sdk: {
          apiEndpoint: optionalString(apiEndpointEl),
          apiKey: optionalString(apiKeyEl),
          effort: optionalString(effortEl),
          maxThinkingTokens: optionalNumber(maxThinkingTokensEl)
        }
      })
    });
    const data = await readJson(response);
    renderStatus({ cwd: lastStatusData?.cwd || '', stateDir: lastStatusData?.stateDir || '', run: data.run });
    showPage('monitor');
    showToast('运行已启动，已切换到 Monitor 页面。');
  } catch (error) {
    renderError(error);
  } finally {
    createButton.disabled = false;
    createButton.textContent = '启动运行';
  }
}

autopilotLevelEl.addEventListener('change', () => applyAutopilotLevel(autopilotLevelEl.value));
for (const input of [dryRunEl, plannerOnlyEl, permissionModeEl]) input.addEventListener('change', maybeMarkCustomAutopilot);
refreshButton.addEventListener('click', () => refresh().catch(renderError));
loadReviewButton.addEventListener('click', loadReview);
saveReviewButton.addEventListener('click', saveReview);
resumeRunButton.addEventListener('click', resumeRun);
pauseRunButton.addEventListener('click', () => callRunControl('Pause', '/api/pause', pauseRunButton, 'pause-after-current-phase'));
controlResumeRunButton.addEventListener('click', () => callRunControl('Resume', '/api/resume', controlResumeRunButton));
cancelRunButton.addEventListener('click', () => callRunControl('Cancel', '/api/cancel', cancelRunButton, 'cancel'));
retryJudgeButton.addEventListener('click', () => callRunControl('Retry Judge', '/api/retry-judge', retryJudgeButton));
clearEventsButton.addEventListener('click', () => { liveEventsEl.innerHTML = ''; syntheticEventKey = ''; });
refreshArtifactsButton.addEventListener('click', () => refreshArtifacts().catch(renderError));
reviewPrdEl.addEventListener('input', renderPrdOverview);
createButton.addEventListener('click', createRun);
loadPromptsButton.addEventListener('click', loadPrompts);
savePromptsButton.addEventListener('click', savePrompts);

setupPageNavigation();
applyAutopilotLevel(autopilotLevelEl.value);
renderPrdOverview();
startEventStream();
Promise.all([refresh(), loadReview(), loadPrompts(), refreshArtifacts({ silent: true })]).catch(renderError);
