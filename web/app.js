const statusEl = document.querySelector('#status');
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

function renderStatus(data) {
  statusEl.textContent = JSON.stringify(data, null, 2);
}

async function readJson(response) {
  const data = await response.json();
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
    renderStatus({ message: '提示语已加载。', prompts: data });
  } finally {
    loadPromptsButton.disabled = false;
    loadPromptsButton.textContent = '重新加载提示语';
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
    const data = await readJson(response);
    renderStatus({ message: '提示语已保存，后续运行会立即使用。', prompts: data });
  } finally {
    savePromptsButton.disabled = false;
    savePromptsButton.textContent = '保存提示语';
  }
}

async function createRun() {
  const prompt = promptEl.value.trim();
  if (!prompt) {
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
    renderStatus(data);
  } finally {
    createButton.disabled = false;
    createButton.textContent = '创建运行';
  }
}

refreshButton.addEventListener('click', refresh);
createButton.addEventListener('click', createRun);
loadPromptsButton.addEventListener('click', loadPrompts);
savePromptsButton.addEventListener('click', savePrompts);

Promise.all([refresh(), loadPrompts()]).catch(error => {
  statusEl.textContent = error instanceof Error ? error.message : String(error);
});
