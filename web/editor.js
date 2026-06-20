// DAG 编辑器：纯 SVG + 鼠标事件，不引入 React / 第三方库。
//
// 设计：
// - 数据模型 = DAG JSON（schema 已定义）。position{x,y} 是 UI-only hint。
// - 拖拽节点：mousedown → mousemove 更新 position → mouseup。
// - 连线：从节点右侧的"out 锚点"按下拖出，松开到另一节点的"in 锚点"建立 inputs 关系。
// - 选中节点 → 右侧 inspector 显示/编辑字段；Delete 键删除选中节点。
// - 工具栏：加载 / 新建 / 保存（PUT /api/templates/:name）。

const NODE_WIDTH = 180;
const NODE_HEIGHT = 70;
const ANCHOR_RADIUS = 6;
const TEMPLATE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const NODE_PALETTE = {
  agent: { fill: '#eff6ff', stroke: '#2563eb' },
  loop: { fill: '#fef3c7', stroke: '#d97706' },
  tool: { fill: '#f0fdf4', stroke: '#16a34a' },
  gather: { fill: '#fae8ff', stroke: '#a21caf' }
};

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

class DagEditor {
  constructor({ canvas, inspector, jsonPreview }) {
    this.canvas = canvas;
    this.inspector = inspector;
    this.jsonPreview = jsonPreview;
    this.svg = null;
    this.dag = this.#blankDag('untitled-dag');
    this.selectedId = null;
    this.dragging = null;
    this.linking = null;
    this.layoutSeed = 0;

    document.addEventListener('keydown', event => this.#onKeyDown(event));
  }

  #blankDag(name) {
    return {
      $schemaVersion: 1,
      name,
      description: '',
      concurrency: 2,
      nodes: []
    };
  }

  loadDag(dag) {
    this.dag = clone(dag);
    this.selectedId = null;
    if (!Array.isArray(this.dag.nodes)) this.dag.nodes = [];
    this.#autoLayoutMissingPositions();
    this.render();
  }

  exportDag() {
    return clone(this.dag);
  }

  #autoLayoutMissingPositions() {
    // Topological layer assignment; nodes in the same layer share a column.
    const inputsOf = new Map(this.dag.nodes.map(n => [n.id, n.inputs || []]));
    const layer = new Map();
    const visit = id => {
      if (layer.has(id)) return layer.get(id);
      const deps = inputsOf.get(id) || [];
      const lvl = deps.length === 0 ? 0 : Math.max(...deps.map(visit)) + 1;
      layer.set(id, lvl);
      return lvl;
    };
    for (const node of this.dag.nodes) visit(node.id);
    const grouped = new Map();
    for (const [id, lvl] of layer) {
      if (!grouped.has(lvl)) grouped.set(lvl, []);
      grouped.get(lvl).push(id);
    }
    for (const node of this.dag.nodes) {
      if (node.position) continue;
      const lvl = layer.get(node.id) || 0;
      const peers = grouped.get(lvl) || [];
      const idx = peers.indexOf(node.id);
      node.position = { x: 60 + lvl * (NODE_WIDTH + 80), y: 40 + idx * (NODE_HEIGHT + 40) };
    }
  }

  render() {
    if (!this.canvas) return;
    const xs = this.dag.nodes.map(n => (n.position?.x || 0) + NODE_WIDTH);
    const ys = this.dag.nodes.map(n => (n.position?.y || 0) + NODE_HEIGHT);
    const width = Math.max(800, ...xs, 600) + 80;
    const height = Math.max(440, ...ys, 400) + 80;

    this.canvas.innerHTML = `
      <svg class="canvas-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMin meet">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
          </marker>
        </defs>
        <g class="edges">${this.#renderEdges()}</g>
        <g class="nodes">${this.#renderNodes()}</g>
      </svg>
      <div class="canvas-toolbar">
        <button type="button" data-action="add-agent">+ agent</button>
        <button type="button" data-action="add-loop">+ loop</button>
        <button type="button" data-action="add-tool">+ tool</button>
        <button type="button" data-action="add-gather">+ gather</button>
        <span class="hint">点击节点选中；拖动节点移动；选中后按 Delete 删除；拖右侧锚点到另一节点建立 inputs 关系。</span>
      </div>
    `;
    this.svg = this.canvas.querySelector('svg');
    this.#wireSvg();
    this.#wireToolbar();
    this.renderInspector();
    if (this.jsonPreview) this.jsonPreview.textContent = JSON.stringify(this.dag, null, 2);
  }

  #renderNodes() {
    return this.dag.nodes.map(node => {
      const pos = node.position || { x: 40, y: 40 };
      const type = node.type || 'agent';
      const palette = NODE_PALETTE[type] || NODE_PALETTE.agent;
      const selected = node.id === this.selectedId ? 'selected' : '';
      const label = node.label || node.id;
      const subline = type === 'agent'
        ? `${node.agentType || '?'} · ${node.model || '?'}`
        : type === 'loop'
          ? `loop x${node.maxIterations ?? '?'}`
          : type === 'tool'
            ? `tool=${node.tool || '?'}`
            : 'gather';
      return `
        <g class="node ${type} ${selected}" data-node-id="${escapeHtml(node.id)}"
           transform="translate(${pos.x}, ${pos.y})">
          <rect class="node-rect" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="12" ry="12"
                fill="${palette.fill}" stroke="${selected ? '#2563eb' : palette.stroke}" stroke-width="${selected ? 2.5 : 1.5}" />
          <text class="node-label" x="14" y="24">${escapeHtml(label)}</text>
          <text class="node-subline" x="14" y="46" font-size="11" fill="#475569">${escapeHtml(subline)}</text>
          <circle class="anchor anchor-in" cx="0" cy="${NODE_HEIGHT / 2}" r="${ANCHOR_RADIUS}" fill="#fff" stroke="#94a3b8" stroke-width="1.5" />
          <circle class="anchor anchor-out" cx="${NODE_WIDTH}" cy="${NODE_HEIGHT / 2}" r="${ANCHOR_RADIUS}" fill="#94a3b8" />
        </g>
      `;
    }).join('');
  }

  #renderEdges() {
    const positions = new Map(this.dag.nodes.map(n => [n.id, n.position || { x: 40, y: 40 }]));
    const lines = [];
    for (const node of this.dag.nodes) {
      const target = positions.get(node.id);
      if (!target) continue;
      for (const sourceId of node.inputs || []) {
        const source = positions.get(sourceId);
        if (!source) continue;
        const x1 = source.x + NODE_WIDTH;
        const y1 = source.y + NODE_HEIGHT / 2;
        const x2 = target.x;
        const y2 = target.y + NODE_HEIGHT / 2;
        const dx = Math.max(40, Math.abs(x2 - x1) / 2);
        lines.push(`<path class="edge" d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" />`);
      }
    }
    if (this.linking) {
      const source = positions.get(this.linking.fromId);
      if (source) {
        const x1 = source.x + NODE_WIDTH;
        const y1 = source.y + NODE_HEIGHT / 2;
        const x2 = this.linking.x;
        const y2 = this.linking.y;
        lines.push(`<path class="edge edge-drag" d="M ${x1} ${y1} L ${x2} ${y2}" stroke-dasharray="4 4" />`);
      }
    }
    return lines.join('');
  }

  #wireSvg() {
    const svg = this.svg;
    if (!svg) return;
    const ptFromEvent = event => {
      const rect = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const x = ((event.clientX - rect.left) / rect.width) * vb.width;
      const y = ((event.clientY - rect.top) / rect.height) * vb.height;
      return { x, y };
    };

    svg.addEventListener('mousedown', event => {
      const targetNodeEl = event.target.closest('[data-node-id]');
      if (!targetNodeEl) { this.selectedId = null; this.render(); return; }
      const nodeId = targetNodeEl.dataset.nodeId;
      this.selectedId = nodeId;

      const anchorOut = event.target.classList?.contains('anchor-out');
      const pt = ptFromEvent(event);
      if (anchorOut) {
        this.linking = { fromId: nodeId, x: pt.x, y: pt.y };
      } else {
        const node = this.dag.nodes.find(n => n.id === nodeId);
        if (node) {
          this.dragging = {
            id: nodeId,
            offsetX: pt.x - (node.position?.x || 0),
            offsetY: pt.y - (node.position?.y || 0)
          };
        }
      }
      this.render();
    });

    svg.addEventListener('mousemove', event => {
      const pt = ptFromEvent(event);
      if (this.dragging) {
        const node = this.dag.nodes.find(n => n.id === this.dragging.id);
        if (node) {
          node.position = node.position || { x: 0, y: 0 };
          node.position.x = pt.x - this.dragging.offsetX;
          node.position.y = pt.y - this.dragging.offsetY;
          this.render();
        }
      } else if (this.linking) {
        this.linking.x = pt.x;
        this.linking.y = pt.y;
        this.render();
      }
    });

    svg.addEventListener('mouseup', event => {
      if (this.linking) {
        const targetEl = event.target.closest('[data-node-id]');
        if (targetEl) {
          const targetId = targetEl.dataset.nodeId;
          if (targetId !== this.linking.fromId) {
            const node = this.dag.nodes.find(n => n.id === targetId);
            if (node) {
              node.inputs = Array.isArray(node.inputs) ? node.inputs : [];
              if (!node.inputs.includes(this.linking.fromId)) node.inputs.push(this.linking.fromId);
            }
          }
        }
        this.linking = null;
      }
      this.dragging = null;
      this.render();
    });

    svg.addEventListener('mouseleave', () => {
      this.dragging = null;
      this.linking = null;
      this.render();
    });
  }

  #wireToolbar() {
    const toolbar = this.canvas.querySelector('.canvas-toolbar');
    if (!toolbar) return;
    toolbar.addEventListener('click', event => {
      const action = event.target?.dataset?.action;
      if (!action) return;
      const type = action.replace('add-', '');
      this.addNode(type);
    });
  }

  addNode(type) {
    const id = uid(type);
    const node = { id, type, inputs: [], position: { x: 80 + this.layoutSeed * 30, y: 80 + this.layoutSeed * 24 } };
    this.layoutSeed = (this.layoutSeed + 1) % 8;
    if (type === 'agent') {
      Object.assign(node, { agentType: 'reader', model: 'planner', promptRef: 'ralph-compound/planner.md', user: '' });
    } else if (type === 'loop') {
      Object.assign(node, { maxIterations: 5, iterationVar: 'round', iterationStart: 1, until: '', subgraph: [
        { id: `${id}_inner`, type: 'agent', agentType: 'writer', model: 'worker', promptRef: 'ralph-compound/worker.md', inputs: [] }
      ]});
    } else if (type === 'tool') {
      Object.assign(node, { tool: 'echo', args: {} });
    } else if (type === 'gather') {
      Object.assign(node, { combine: 'all' });
    }
    this.dag.nodes.push(node);
    this.selectedId = id;
    this.render();
  }

  removeSelected() {
    if (!this.selectedId) return;
    this.dag.nodes = this.dag.nodes.filter(n => n.id !== this.selectedId);
    for (const node of this.dag.nodes) {
      if (Array.isArray(node.inputs)) node.inputs = node.inputs.filter(id => id !== this.selectedId);
    }
    this.selectedId = null;
    this.render();
  }

  #onKeyDown(event) {
    if (event.target?.tagName === 'INPUT' || event.target?.tagName === 'TEXTAREA' || event.target?.tagName === 'SELECT') return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedId) {
      event.preventDefault();
      this.removeSelected();
    }
  }

  renderInspector() {
    if (!this.inspector) return;
    const node = this.dag.nodes.find(n => n.id === this.selectedId);
    if (!node) {
      this.inspector.innerHTML = `
        <label>name<input type="text" id="dag-name" value="${escapeHtml(this.dag.name)}" /></label>
        <label>description<textarea id="dag-desc">${escapeHtml(this.dag.description || '')}</textarea></label>
        <label>concurrency<input type="number" id="dag-concurrency" min="1" step="1" value="${escapeHtml(this.dag.concurrency || 2)}" /></label>
        <p class="hint">点击画布上的节点查看 / 编辑节点属性；选中后按 Delete 删除。</p>
      `;
      this.inspector.querySelector('#dag-name').addEventListener('input', e => { this.dag.name = e.target.value; this.#refreshPreview(); });
      this.inspector.querySelector('#dag-desc').addEventListener('input', e => { this.dag.description = e.target.value; this.#refreshPreview(); });
      this.inspector.querySelector('#dag-concurrency').addEventListener('input', e => {
        const n = Number(e.target.value);
        if (Number.isInteger(n) && n >= 1) { this.dag.concurrency = n; this.#refreshPreview(); }
      });
      return;
    }
    const type = node.type || 'agent';
    const inputsList = (node.inputs || []).join(',');
    let typeFields = '';
    if (type === 'agent') {
      typeFields = `
        <label>agentType
          <select data-field="agentType">
            <option value="reader" ${node.agentType === 'reader' ? 'selected' : ''}>reader</option>
            <option value="writer" ${node.agentType === 'writer' ? 'selected' : ''}>writer</option>
            <option value="judge" ${node.agentType === 'judge' ? 'selected' : ''}>judge</option>
          </select>
        </label>
        <label>model<input type="text" data-field="model" value="${escapeHtml(node.model || '')}" placeholder="planner / worker / judge 或 sdk model id" /></label>
        <label>promptRef<input type="text" data-field="promptRef" value="${escapeHtml(node.promptRef || '')}" placeholder="ralph-compound/planner.md" /></label>
        <label>user (template)<textarea data-field="user">${escapeHtml(node.user || '')}</textarea></label>
        <label>allowedTools (逗号分隔，留空走 agentType 默认)<input type="text" data-field="allowedTools" value="${escapeHtml((node.allowedTools || []).join(','))}" /></label>
        <label><input type="checkbox" data-field-bool="hooks.captureGitEvidence" ${node.hooks?.captureGitEvidence ? 'checked' : ''} /> captureGitEvidence</label>
        <label><input type="checkbox" data-field-bool="hooks.writeJudgeVerdictJson" ${node.hooks?.writeJudgeVerdictJson ? 'checked' : ''} /> writeJudgeVerdictJson</label>
      `;
    } else if (type === 'loop') {
      typeFields = `
        <label>maxIterations<input type="number" data-field="maxIterations" min="1" step="1" value="${escapeHtml(node.maxIterations ?? 5)}" /></label>
        <label>iterationVar<input type="text" data-field="iterationVar" value="${escapeHtml(node.iterationVar || 'round')}" /></label>
        <label>iterationStart<input type="number" data-field="iterationStart" min="0" step="1" value="${escapeHtml(node.iterationStart ?? 1)}" /></label>
        <label>until (表达式)<input type="text" data-field="until" value="${escapeHtml(node.until || '')}" placeholder="nodes.judge.json.verdict == 'PASS'" /></label>
        <label>subgraph (JSON 数组)<textarea data-field-json="subgraph">${escapeHtml(JSON.stringify(node.subgraph || [], null, 2))}</textarea></label>
      `;
    } else if (type === 'tool') {
      typeFields = `
        <label>tool<input type="text" data-field="tool" value="${escapeHtml(node.tool || '')}" placeholder="verifyRunCompletion / echo / sleep" /></label>
        <label>args (JSON)<textarea data-field-json="args">${escapeHtml(JSON.stringify(node.args || {}, null, 2))}</textarea></label>
      `;
    } else if (type === 'gather') {
      typeFields = `
        <label>combine
          <select data-field="combine">
            <option value="all" ${node.combine === 'all' ? 'selected' : ''}>all</option>
            <option value="first" ${node.combine === 'first' ? 'selected' : ''}>first</option>
            <option value="last" ${node.combine === 'last' ? 'selected' : ''}>last</option>
          </select>
        </label>
      `;
    }
    this.inspector.innerHTML = `
      <h3>${escapeHtml(node.id)} <small>(${escapeHtml(type)})</small></h3>
      <label>id<input type="text" data-field="id" value="${escapeHtml(node.id)}" /></label>
      <label>label<input type="text" data-field="label" value="${escapeHtml(node.label || '')}" /></label>
      <label>inputs (逗号分隔)<input type="text" data-field-list="inputs" value="${escapeHtml(inputsList)}" /></label>
      ${typeFields}
      <div class="inspector-actions">
        <button class="button button-danger danger-button" type="button" id="inspector-delete">删除节点</button>
      </div>
    `;
    for (const el of this.inspector.querySelectorAll('[data-field]')) {
      el.addEventListener('input', () => this.#applyFieldChange(node, el));
      el.addEventListener('change', () => this.#applyFieldChange(node, el));
    }
    for (const el of this.inspector.querySelectorAll('[data-field-list]')) {
      el.addEventListener('input', () => {
        node[el.dataset.fieldList] = el.value.split(',').map(s => s.trim()).filter(Boolean);
        this.#refreshPreview();
        this.render();
      });
    }
    for (const el of this.inspector.querySelectorAll('[data-field-bool]')) {
      el.addEventListener('change', () => {
        const [parent, key] = el.dataset.fieldBool.split('.');
        if (!node[parent] || typeof node[parent] !== 'object') node[parent] = {};
        node[parent][key] = el.checked;
        this.#refreshPreview();
      });
    }
    for (const el of this.inspector.querySelectorAll('[data-field-json]')) {
      el.addEventListener('input', () => {
        try {
          node[el.dataset.fieldJson] = JSON.parse(el.value);
          el.style.borderColor = '';
          this.#refreshPreview();
        } catch {
          el.style.borderColor = '#dc2626';
        }
      });
    }
    this.inspector.querySelector('#inspector-delete')?.addEventListener('click', () => this.removeSelected());
  }

  #applyFieldChange(node, el) {
    const field = el.dataset.field;
    let value = el.value;
    if (el.type === 'number') { const n = Number(value); value = Number.isFinite(n) ? n : value; }
    if (field === 'id') {
      const newId = String(value || '').trim();
      if (!newId || newId === node.id) return;
      const oldId = node.id;
      for (const other of this.dag.nodes) {
        if (Array.isArray(other.inputs)) other.inputs = other.inputs.map(id => id === oldId ? newId : id);
      }
      node.id = newId;
      this.selectedId = newId;
      this.render();
      return;
    }
    node[field] = value;
    this.#refreshPreview();
    this.render();
  }

  #refreshPreview() {
    if (this.jsonPreview) this.jsonPreview.textContent = JSON.stringify(this.dag, null, 2);
  }
}

export function initEditor() {
  const canvas = document.querySelector('#editorCanvas');
  const inspector = document.querySelector('#editorInspectorBody');
  const jsonPreview = document.querySelector('#editorJsonPreview');
  const templateSelect = document.querySelector('#editorTemplate');
  const loadBtn = document.querySelector('#editorLoad');
  const newBtn = document.querySelector('#editorNew');
  const saveBtn = document.querySelector('#editorSave');
  if (!canvas || !inspector) return null;

  const editor = new DagEditor({ canvas, inspector, jsonPreview });

  async function loadFromServer(name) {
    if (!name) return;
    const response = await fetch(`/api/templates/${encodeURIComponent(name)}`);
    if (!response.ok) { alert(`加载失败: ${response.status}`); return; }
    const data = await response.json();
    editor.loadDag(data.dag);
  }

  loadBtn?.addEventListener('click', () => loadFromServer(templateSelect?.value));
  newBtn?.addEventListener('click', () => {
    const name = prompt('新模板名（字母开头，只允许字母数字下划线短横线）：', `custom-${Math.random().toString(36).slice(2, 6)}`);
    if (!name || !TEMPLATE_NAME_PATTERN.test(name)) { alert('名字非法'); return; }
    editor.loadDag({ $schemaVersion: 1, name, description: '', concurrency: 2, nodes: [] });
  });
  saveBtn?.addEventListener('click', async () => {
    const dag = editor.exportDag();
    if (!TEMPLATE_NAME_PATTERN.test(dag.name || '')) {
      alert('请先在 inspector 中设置合法的模板 name（字母开头，字母数字下划线短横线）。');
      return;
    }
    try {
      const response = await fetch(`/api/templates/${encodeURIComponent(dag.name)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dag })
      });
      const body = await response.json();
      if (!response.ok) { alert(`保存失败：${body.error || response.status}`); return; }
      alert(`已保存到 ${body.path}`);
    } catch (error) {
      alert(`保存错误：${error.message}`);
    }
  });

  // Bootstrap with the first template the server knows about (typically ralph-compound).
  fetch('/api/templates').then(r => r.json()).then(data => {
    const first = (data.templates || [])[0]?.name;
    if (first) loadFromServer(first);
    else editor.loadDag({ $schemaVersion: 1, name: 'new-dag', description: '', concurrency: 2, nodes: [] });
  }).catch(() => editor.loadDag({ $schemaVersion: 1, name: 'new-dag', description: '', concurrency: 2, nodes: [] }));

  return editor;
}

// Auto-init when imported as an ES module.
initEditor();
