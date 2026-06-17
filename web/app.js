const statusEl = document.querySelector('#status');
const statusSummaryEl = document.querySelector('#statusSummary');
const phaseTimelineEl = document.querySelector('#phaseTimeline');
const promptEl = document.querySelector('#prompt');
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
const reviewSpecEl = document.querySelector('#reviewSpec');
const reviewPrdEl = document.querySelector('#reviewPrd');

const AUTO_REFRESH_STATUSES = new Set(['waiting-for-agent-adapter', 'running']);
const SAFE_CLASS_TOKEN = /^[a-z0-9_-]+$/i;
const STATUS_LABELS = {
  initialized: '已初始化',
  planned: '已规划',
  'waiting-for-agent-adapter': '等待 Agent',
  running: '运行中',
  'waiting-for-review': '等待人工检查',
  completed: '已完成',
  failed: '失败',
  max_rounds_reached: '达到最大轮数'
};
const ROLE_LABELS = { planner: 'Planner', worker: 'Worker', judge: 'Judge' };

let refreshTimer;
let lastStatusData;

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

function renderStatus(data) {
  lastStatusData = data;
  statusEl.textContent = JSON.stringify(data, null, 2);
  renderSummary(data);
  renderTimeline(data.run);
  resumeRunButton.disabled = data.run?.status !== 'waiting-for-review';
  setAutoRefresh(data.run);
}

function renderError(error) {
  const message = error instanceof Error ? error.message : String(error);
  statusSummaryEl.innerHTML = `<div class="error-card"><strong>请求失败</strong><p>${escapeHtml(message)}</p></div>`;
  statusEl.textContent = message;
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

async function refresh() {
  const response = await fetch('/api/status');
  renderStatus(await readJson(response));
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
    statusSummaryEl.querySelector('.success-card')?.remove();
    statusSummaryEl.insertAdjacentHTML('afterbegin', '<div class="success-card">Planner 产物已保存，可以继续运行。</div>');
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
  } catch (error) {
    renderError(error);
  } finally {
    resumeRunButton.textContent = '继续运行';
    resumeRunButton.disabled = lastStatusData?.run?.status !== 'waiting-for-review';
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
    statusSummaryEl.querySelector('.success-card')?.remove();
    statusSummaryEl.insertAdjacentHTML('afterbegin', '<div class="success-card">提示语已保存，后续运行会立即使用。</div>');
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
  } catch (error) {
    renderError(error);
  } finally {
    createButton.disabled = false;
    createButton.textContent = '启动运行';
  }
}

refreshButton.addEventListener('click', () => refresh().catch(renderError));
loadReviewButton.addEventListener('click', loadReview);
saveReviewButton.addEventListener('click', saveReview);
resumeRunButton.addEventListener('click', resumeRun);
createButton.addEventListener('click', createRun);
loadPromptsButton.addEventListener('click', loadPrompts);
savePromptsButton.addEventListener('click', savePrompts);

Promise.all([refresh(), loadReview(), loadPrompts()]).catch(renderError);
