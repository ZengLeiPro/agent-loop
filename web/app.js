const statusEl = document.querySelector('#status');
const promptEl = document.querySelector('#prompt');
const dryRunEl = document.querySelector('#dryRun');
const refreshButton = document.querySelector('#refresh');
const createButton = document.querySelector('#create');

async function refresh() {
  const response = await fetch('/api/status');
  const data = await response.json();
  statusEl.textContent = JSON.stringify(data, null, 2);
}

async function createRun() {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    promptEl.focus();
    return;
  }
  const response = await fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, dryRun: dryRunEl.checked })
  });
  const data = await response.json();
  statusEl.textContent = JSON.stringify(data, null, 2);
}

refreshButton.addEventListener('click', refresh);
createButton.addEventListener('click', createRun);
refresh().catch(error => {
  statusEl.textContent = error instanceof Error ? error.message : String(error);
});
