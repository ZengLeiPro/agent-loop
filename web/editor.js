// DAG 编辑器 —— @xyflow/react (ReactFlow 12) + React 18 + htm，全部通过 esm.sh 加载，无 build step。
//
// 数据流：
//   load template → dagToFlow → useNodesState/useEdgesState (RF source of truth)
//   user drags / connects / edits → setNodes / setEdges / mutate data
//   save → flowToDag(nodes, edges, meta) → PUT /api/templates/:name
//
// DAG schema 与 RF 模型的差异：
//   - schema 的 inputs[] 隐式表达边 → flowToDag 时从 edges 重建。
//   - 节点的 position 在 schema 是可选 UI hint；dagToFlow 自动布局（拓扑分层）填补缺失。
//
// 单一 custom node type 'dag' 渲染所有类型，由 data.dagType 区分配色 / handles / 副标题。

import React from 'https://esm.sh/react@18';
import { createRoot } from 'https://esm.sh/react-dom@18/client?deps=react@18';
import htm from 'https://esm.sh/htm@3';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  applyNodeChanges
} from 'https://esm.sh/@xyflow/react@12?deps=react@18,react-dom@18';

const { useState, useEffect, useCallback, useMemo, useRef } = React;
const html = htm.bind(React.createElement);

const TEMPLATE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const NODE_PALETTE = {
  agent: { stroke: '#2563eb', fill: '#eff6ff', accent: '#1d4ed8', label: 'Agent' },
  loop: { stroke: '#d97706', fill: '#fef3c7', accent: '#b45309', label: 'Loop' },
  tool: { stroke: '#16a34a', fill: '#f0fdf4', accent: '#15803d', label: 'Tool' },
  gather: { stroke: '#a21caf', fill: '#fae8ff', accent: '#7e22ce', label: 'Gather' }
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function uid(prefix) { return `${prefix}_${Math.random().toString(36).slice(2, 8)}`; }

// ===== DAG ↔ RF 转换 =====

function autoLayout(dagNodes) {
  // Topological layer assignment. Nodes inside the same layer share an x; y staggers.
  const inputsOf = new Map(dagNodes.map(n => [n.id, n.inputs || []]));
  const layer = new Map();
  const visit = id => {
    if (layer.has(id)) return layer.get(id);
    const deps = inputsOf.get(id) || [];
    const lvl = deps.length === 0 ? 0 : Math.max(...deps.map(visit)) + 1;
    layer.set(id, lvl);
    return lvl;
  };
  for (const node of dagNodes) visit(node.id);
  const grouped = new Map();
  for (const [id, lvl] of layer) {
    if (!grouped.has(lvl)) grouped.set(lvl, []);
    grouped.get(lvl).push(id);
  }
  const positions = new Map();
  for (const node of dagNodes) {
    if (node.position) { positions.set(node.id, node.position); continue; }
    const lvl = layer.get(node.id) || 0;
    const peers = grouped.get(lvl) || [];
    const idx = peers.indexOf(node.id);
    positions.set(node.id, { x: 80 + lvl * 260, y: 60 + idx * 140 });
  }
  return positions;
}

function subline(node) {
  const type = node.type || 'agent';
  if (type === 'agent') return `${node.agentType || '?'} · ${node.model || '?'}`;
  if (type === 'loop') return `loop ×${node.maxIterations ?? '?'} (${(node.subgraph || []).length} sub)`;
  if (type === 'tool') return `tool: ${node.tool || '?'}`;
  return `gather: ${node.combine || 'all'}`;
}

function dagToFlow(dag) {
  if (!dag || !Array.isArray(dag.nodes)) return { nodes: [], edges: [] };
  const positions = autoLayout(dag.nodes);
  const nodes = dag.nodes.map(n => ({
    id: n.id,
    type: 'dag',
    position: positions.get(n.id) || { x: 80, y: 80 },
    data: { ...n, dagType: n.type || 'agent', subline: subline(n) }
  }));
  const edges = [];
  for (const node of dag.nodes) {
    for (const sourceId of node.inputs || []) {
      edges.push({
        id: `e_${sourceId}_${node.id}`,
        source: sourceId,
        target: node.id,
        animated: false,
        style: { stroke: '#64748b', strokeWidth: 1.5 }
      });
    }
  }
  return { nodes, edges };
}

function flowToDag(rfNodes, rfEdges, meta) {
  const inputsByTarget = new Map();
  for (const edge of rfEdges) {
    if (!edge.source || !edge.target) continue;
    if (!inputsByTarget.has(edge.target)) inputsByTarget.set(edge.target, []);
    const arr = inputsByTarget.get(edge.target);
    if (!arr.includes(edge.source)) arr.push(edge.source);
  }
  const nodes = rfNodes.map(rfNode => {
    const data = rfNode.data || {};
    // Strip UI-only fields the editor injects.
    const { dagType, subline: _sub, label: _label, ...rest } = data;
    const dagNode = clone(rest);
    dagNode.id = rfNode.id;
    dagNode.type = dagType || rest.type || 'agent';
    dagNode.inputs = inputsByTarget.get(rfNode.id) || [];
    dagNode.position = { x: Math.round(rfNode.position.x), y: Math.round(rfNode.position.y) };
    return dagNode;
  });
  return {
    $schemaVersion: 1,
    name: meta.name,
    description: meta.description || '',
    concurrency: Number.isInteger(meta.concurrency) && meta.concurrency >= 1 ? meta.concurrency : 2,
    nodes
  };
}

function newNode(type, position) {
  const id = uid(type);
  const node = { id, type, inputs: [], position };
  if (type === 'agent') {
    Object.assign(node, {
      agentType: 'reader',
      model: 'planner',
      promptRef: 'ralph-compound/planner.md',
      user: ''
    });
  } else if (type === 'loop') {
    Object.assign(node, {
      maxIterations: 5,
      iterationVar: 'round',
      iterationStart: 1,
      until: '',
      subgraph: [
        { id: `${id}_inner`, type: 'agent', agentType: 'writer', model: 'worker', promptRef: 'ralph-compound/worker.md', inputs: [] }
      ]
    });
  } else if (type === 'tool') {
    Object.assign(node, { tool: 'echo', args: {} });
  } else if (type === 'gather') {
    Object.assign(node, { combine: 'all' });
  }
  return node;
}

// ===== React 组件 =====

function DagNode({ id, data, selected }) {
  const palette = NODE_PALETTE[data.dagType] || NODE_PALETTE.agent;
  return html`
    <div class="rf-dag-node" data-selected=${selected ? '1' : '0'}
         style=${{
           background: palette.fill,
           borderColor: selected ? '#2563eb' : palette.stroke,
           borderWidth: selected ? 2 : 1.5,
           boxShadow: selected ? '0 0 0 3px rgb(37 99 235 / 18%)' : '0 1px 2px rgb(15 23 42 / 8%)'
         }}>
      <${Handle} type="target" position=${Position.Left} className="rf-dag-handle" />
      <div class="rf-dag-row1">
        <span class="rf-dag-tag" style=${{ background: palette.accent }}>${palette.label}</span>
        <span class="rf-dag-id">${data.label || id}</span>
      </div>
      <div class="rf-dag-row2">${data.subline || ''}</div>
      <${Handle} type="source" position=${Position.Right} className="rf-dag-handle" />
    </div>
  `;
}

const nodeTypes = { dag: DagNode };

function Toolbar({ templates, activeTemplate, onLoad, onNew, onSave, onAddNode, dirty }) {
  return html`
    <div class="rf-toolbar">
      <select value=${activeTemplate} onChange=${e => onLoad(e.target.value)} aria-label="加载模板">
        <option value="">— 选择模板加载 —</option>
        ${templates.map(t => html`<option key=${t.name} value=${t.name}>${t.name}${t.source === 'user' ? '（用户）' : '（内置）'}</option>`)}
      </select>
      <button class="rf-tool-btn" type="button" onClick=${onNew}>新建模板</button>
      <button class="rf-tool-btn rf-tool-primary" type="button" onClick=${onSave}>保存${dirty ? ' ●' : ''}</button>
      <span class="rf-toolbar-divider" />
      <span class="rf-toolbar-label">+ 节点</span>
      <button class="rf-add-btn rf-add-agent" type="button" onClick=${() => onAddNode('agent')}>Agent</button>
      <button class="rf-add-btn rf-add-loop" type="button" onClick=${() => onAddNode('loop')}>Loop</button>
      <button class="rf-add-btn rf-add-tool" type="button" onClick=${() => onAddNode('tool')}>Tool</button>
      <button class="rf-add-btn rf-add-gather" type="button" onClick=${() => onAddNode('gather')}>Gather</button>
    </div>
  `;
}

function Field({ label, children, hint }) {
  return html`
    <label class="rf-field">
      <span class="rf-field-label">${label}${hint ? html`<small> · ${hint}</small>` : null}</span>
      ${children}
    </label>
  `;
}

function MetaInspector({ meta, onChange }) {
  return html`
    <div class="rf-inspector-body">
      <h3>模板元信息</h3>
      <${Field} label="name" hint="文件名 / --template 用">
        <input type="text" value=${meta.name} onInput=${e => onChange({ ...meta, name: e.target.value })}
               pattern="[a-zA-Z][a-zA-Z0-9_-]*" />
      </${Field}>
      <${Field} label="description">
        <textarea rows="3" onInput=${e => onChange({ ...meta, description: e.target.value })}
                  defaultValue=${meta.description || ''} />
      </${Field}>
      <${Field} label="concurrency" hint="并发节点上限">
        <input type="number" min="1" step="1" value=${meta.concurrency || 2}
               onInput=${e => {
                 const n = Number(e.target.value);
                 if (Number.isInteger(n) && n >= 1) onChange({ ...meta, concurrency: n });
               }} />
      </${Field}>
      <p class="rf-hint">点击画布节点编辑属性。空白处按 Delete 无效，节点选中后按 Delete / Backspace 删除。</p>
    </div>
  `;
}

function NodeInspector({ node, allNodeIds, onChangeNode, onChangeNodeId, onRemoveNode }) {
  const dagType = node.data.dagType;
  const data = node.data;

  // Use function patches so multiple rapid edits (e.g. two consecutive hook checkboxes)
  // see the latest data, not the stale closure capture.
  const setField = (field, value) => onChangeNode(node.id, { [field]: value });
  const setHook = (key, value) => onChangeNode(node.id, prev => ({ hooks: { ...(prev.hooks || {}), [key]: value } }));
  const setRetry = (key, value) => onChangeNode(node.id, prev => ({ retries: { ...(prev.retries || {}), [key]: value } }));

  const idField = html`
    <${Field} label="id" hint="唯一，[a-zA-Z][a-zA-Z0-9_-]*">
      <input type="text" defaultValue=${node.id}
             onBlur=${e => {
               const v = e.target.value.trim();
               if (v && v !== node.id) onChangeNodeId(node.id, v);
               else if (!v) e.target.value = node.id;
             }} />
    </${Field}>`;

  const labelField = html`
    <${Field} label="label">
      <input type="text" defaultValue=${data.label || ''}
             onBlur=${e => setField('label', e.target.value)} />
    </${Field}>`;

  let typeFields = null;
  if (dagType === 'agent') {
    typeFields = html`
      <${Field} label="agentType">
        <select value=${data.agentType || 'reader'} onChange=${e => setField('agentType', e.target.value)}>
          <option value="reader">reader</option>
          <option value="writer">writer</option>
          <option value="judge">judge</option>
        </select>
      </${Field}>
      <${Field} label="model" hint="planner / worker / judge 或 SDK model id">
        <input type="text" defaultValue=${data.model || ''}
               onBlur=${e => setField('model', e.target.value)} />
      </${Field}>
      <${Field} label="promptRef" hint="prompts/ 下相对路径">
        <input type="text" defaultValue=${data.promptRef || ''} placeholder="ralph-compound/planner.md"
               onBlur=${e => setField('promptRef', e.target.value)} />
      </${Field}>
      <${Field} label="user (template)" hint="{{input.prompt}} / {{nodes.id.text}} / {{loop.round}}">
        <textarea rows="4" defaultValue=${data.user || ''}
                  onBlur=${e => setField('user', e.target.value)} />
      </${Field}>
      <${Field} label="allowedTools" hint="逗号分隔；留空走 agentType 默认">
        <input type="text" defaultValue=${(data.allowedTools || []).join(',')}
               onBlur=${e => setField('allowedTools', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} />
      </${Field}>
      <div class="rf-checkbox-group">
        <label><input type="checkbox" checked=${data.hooks?.captureGitEvidence || false}
                      onChange=${e => setHook('captureGitEvidence', e.target.checked)} /> captureGitEvidence</label>
        <label><input type="checkbox" checked=${data.hooks?.writeJudgeVerdictJson || false}
                      onChange=${e => setHook('writeJudgeVerdictJson', e.target.checked)} /> writeJudgeVerdictJson</label>
      </div>
      <${Field} label="retries.max" hint="失败重试次数（0 = 不重试）">
        <input type="number" min="0" defaultValue=${data.retries?.max ?? 0}
               onBlur=${e => setRetry('max', Number(e.target.value) || 0)} />
      </${Field}>
      <${Field} label="retries.backoffMs" hint="首次退避毫秒；指数增长">
        <input type="number" min="0" defaultValue=${data.retries?.backoffMs ?? 1000}
               onBlur=${e => setRetry('backoffMs', Number(e.target.value) || 0)} />
      </${Field}>
      <label><input type="checkbox" checked=${data.cache?.enabled || false}
                    onChange=${e => setField('cache', { enabled: e.target.checked })} /> 启用节点缓存</label>
    `;
  } else if (dagType === 'loop') {
    typeFields = html`
      <${Field} label="maxIterations">
        <input type="number" min="1" defaultValue=${data.maxIterations ?? 5}
               onBlur=${e => setField('maxIterations', Number(e.target.value) || 1)} />
      </${Field}>
      <${Field} label="iterationVar">
        <input type="text" defaultValue=${data.iterationVar || 'round'}
               onBlur=${e => setField('iterationVar', e.target.value)} />
      </${Field}>
      <${Field} label="iterationStart">
        <input type="number" min="0" defaultValue=${data.iterationStart ?? 1}
               onBlur=${e => setField('iterationStart', Number(e.target.value) || 0)} />
      </${Field}>
      <${Field} label="until 表达式" hint="例：nodes.judge.json.verdict == 'PASS'">
        <input type="text" defaultValue=${data.until || ''}
               onBlur=${e => setField('until', e.target.value)} />
      </${Field}>
      <${Field} label="subgraph (JSON 数组)" hint="loop 内子节点定义；红框=JSON 不合法">
        <${JsonEditor} value=${data.subgraph || []}
                       onSave=${value => setField('subgraph', value)} />
      </${Field}>
    `;
  } else if (dagType === 'tool') {
    typeFields = html`
      <${Field} label="tool" hint="verifyRunCompletion / echo / sleep / 自定义">
        <input type="text" defaultValue=${data.tool || ''}
               onBlur=${e => setField('tool', e.target.value)} />
      </${Field}>
      <${Field} label="args (JSON)" hint="值可用 {{path}} 模板">
        <${JsonEditor} value=${data.args || {}}
                       onSave=${value => setField('args', value)} />
      </${Field}>
    `;
  } else if (dagType === 'gather') {
    typeFields = html`
      <${Field} label="combine">
        <select value=${data.combine || 'all'} onChange=${e => setField('combine', e.target.value)}>
          <option value="all">all — 收集所有上游 → { [id]: output }</option>
          <option value="first">first — 取首个上游</option>
          <option value="last">last — 取末个上游</option>
        </select>
      </${Field}>
    `;
  }

  return html`
    <div class="rf-inspector-body">
      <h3>${node.id} <small class="rf-type-pill rf-type-${dagType}">${dagType}</small></h3>
      ${idField}
      ${labelField}
      ${typeFields}
      <div class="rf-inspector-actions">
        <button class="rf-tool-btn rf-tool-danger" type="button" onClick=${() => onRemoveNode(node.id)}>删除节点</button>
      </div>
    </div>
  `;
}

function JsonEditor({ value, onSave }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState(null);

  useEffect(() => {
    setText(JSON.stringify(value, null, 2));
    setError(null);
  }, [JSON.stringify(value)]);

  return html`
    <div class="rf-json-editor">
      <textarea rows="6" value=${text}
                onInput=${e => setText(e.target.value)}
                onBlur=${() => {
                  try {
                    const parsed = JSON.parse(text);
                    setError(null);
                    onSave(parsed);
                  } catch (err) {
                    setError(err.message);
                  }
                }}
                style=${{ borderColor: error ? '#dc2626' : '' }} />
      ${error ? html`<small class="rf-json-error">${error}</small>` : null}
    </div>
  `;
}

function showToast(message, variant = 'success') {
  const region = document.querySelector('#toastRegion');
  if (!region) { alert(message); return; }
  const toast = document.createElement('div');
  toast.className = `toast toast-${variant}`;
  toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');
  toast.innerHTML = `<strong>${message.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])}</strong>`;
  region.append(toast);
  setTimeout(() => toast.classList.add('toast-visible'), 20);
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 4200);
}

function DagEditorApp() {
  const [meta, setMeta] = useState({ name: 'new-dag', description: '', concurrency: 2 });
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [templates, setTemplates] = useState([]);
  const [activeTemplate, setActiveTemplate] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [dirty, setDirty] = useState(false);
  const reactFlowWrapper = useRef(null);
  const rf = useReactFlow();

  // Re-fit viewport whenever a different template loads.
  useEffect(() => {
    if (!activeTemplate || !nodes.length) return;
    const timer = setTimeout(() => {
      try { rf.fitView({ padding: 0.18, duration: 280, includeHiddenNodes: false }); } catch {}
    }, 50);
    return () => clearTimeout(timer);
  }, [activeTemplate]);

  // Fetch templates list once on mount.
  useEffect(() => {
    fetch('/api/templates').then(r => r.json()).then(data => {
      const list = data.templates || [];
      setTemplates(list);
      // Auto-load the first one (typically ralph-compound) for nice first impression.
      if (list.length && !activeTemplate) loadTemplate(list[0].name);
    }).catch(() => {});
  }, []);

  // Refresh templates after save.
  const refreshTemplateList = useCallback(() => {
    fetch('/api/templates').then(r => r.json()).then(data => setTemplates(data.templates || [])).catch(() => {});
  }, []);

  const loadTemplate = useCallback(async name => {
    if (!name) return;
    try {
      const response = await fetch(`/api/templates/${encodeURIComponent(name)}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        showToast(`加载失败：${body.error || response.status}`, 'error');
        return;
      }
      const data = await response.json();
      const dag = data.dag;
      const flow = dagToFlow(dag);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setMeta({ name: dag.name, description: dag.description || '', concurrency: dag.concurrency || 2 });
      setActiveTemplate(name);
      setSelectedId(null);
      setDirty(false);
    } catch (error) {
      showToast(error.message, 'error');
    }
  }, [setNodes, setEdges]);

  const newTemplate = useCallback(() => {
    const name = window.prompt('新模板名（字母开头，字母数字下划线短横线）：', `custom-${Math.random().toString(36).slice(2, 6)}`);
    if (!name) return;
    if (!TEMPLATE_NAME_PATTERN.test(name)) { showToast('名字非法。', 'error'); return; }
    setMeta({ name, description: '', concurrency: 2 });
    setNodes([]);
    setEdges([]);
    setActiveTemplate('');
    setSelectedId(null);
    setDirty(true);
  }, [setNodes, setEdges]);

  const saveTemplate = useCallback(async () => {
    if (!TEMPLATE_NAME_PATTERN.test(meta.name || '')) {
      showToast('请先填写合法的模板 name（字母开头）。', 'error');
      return;
    }
    const dag = flowToDag(nodes, edges, meta);
    try {
      const response = await fetch(`/api/templates/${encodeURIComponent(dag.name)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dag })
      });
      const body = await response.json();
      if (!response.ok) {
        showToast(`保存失败：${body.error || response.status}`, 'error');
        return;
      }
      showToast(`已保存到 ${body.path}`);
      setDirty(false);
      refreshTemplateList();
      setActiveTemplate(dag.name);
    } catch (error) {
      showToast(error.message, 'error');
    }
  }, [meta, nodes, edges, refreshTemplateList]);

  const addNode = useCallback(type => {
    // Place near canvas center.
    const wrap = reactFlowWrapper.current;
    const rect = wrap?.getBoundingClientRect();
    const x = rect ? rect.width / 2 - 90 : 200;
    const y = rect ? rect.height / 2 - 35 : 200;
    const node = newNode(type, { x, y });
    const rfNode = {
      id: node.id,
      type: 'dag',
      position: node.position,
      data: { ...node, dagType: node.type, subline: subline(node) }
    };
    setNodes(curr => [...curr, rfNode]);
    setSelectedId(node.id);
    setDirty(true);
  }, [setNodes]);

  const removeNode = useCallback(id => {
    setNodes(curr => curr.filter(n => n.id !== id));
    setEdges(curr => curr.filter(e => e.source !== id && e.target !== id));
    if (selectedId === id) setSelectedId(null);
    setDirty(true);
  }, [setNodes, setEdges, selectedId]);

  const changeNode = useCallback((id, patchOrFn) => {
    setNodes(curr => curr.map(n => {
      if (n.id !== id) return n;
      const patch = typeof patchOrFn === 'function' ? patchOrFn(n.data) : patchOrFn;
      const newData = { ...n.data, ...patch };
      return { ...n, data: { ...newData, subline: subline(newData) } };
    }));
    setDirty(true);
  }, [setNodes]);

  const changeNodeId = useCallback((oldId, newId) => {
    if (!TEMPLATE_NAME_PATTERN.test(newId)) {
      showToast(`id 不合法："${newId}" 必须匹配 [a-zA-Z][a-zA-Z0-9_-]*`, 'error');
      return;
    }
    setNodes(curr => {
      if (curr.some(n => n.id === newId)) {
        showToast(`id 已存在："${newId}"`, 'error');
        return curr;
      }
      return curr.map(n => n.id === oldId ? { ...n, id: newId, data: { ...n.data } } : n);
    });
    setEdges(curr => curr.map(e => ({
      ...e,
      source: e.source === oldId ? newId : e.source,
      target: e.target === oldId ? newId : e.target,
      id: `e_${e.source === oldId ? newId : e.source}_${e.target === oldId ? newId : e.target}`
    })));
    if (selectedId === oldId) setSelectedId(newId);
    setDirty(true);
  }, [setNodes, setEdges, selectedId]);

  const onConnect = useCallback(params => {
    const newEdge = {
      ...params,
      id: `e_${params.source}_${params.target}`,
      animated: false,
      style: { stroke: '#64748b', strokeWidth: 1.5 }
    };
    setEdges(curr => addEdge(newEdge, curr));
    setDirty(true);
  }, [setEdges]);

  const handleNodesChange = useCallback(changes => {
    onNodesChange(changes);
    // Mark dirty only for meaningful changes (drag = position; user delete).
    if (changes.some(c => c.type === 'position' || c.type === 'remove')) setDirty(true);
  }, [onNodesChange]);

  const handleEdgesChange = useCallback(changes => {
    onEdgesChange(changes);
    if (changes.some(c => c.type === 'remove')) setDirty(true);
  }, [onEdgesChange]);

  const onNodeClick = useCallback((_evt, node) => setSelectedId(node.id), []);

  const onPaneClick = useCallback(() => setSelectedId(null), []);

  const selectedNode = useMemo(() => nodes.find(n => n.id === selectedId) || null, [nodes, selectedId]);

  const inspector = selectedNode
    ? html`<${NodeInspector} node=${selectedNode}
            allNodeIds=${nodes.map(n => n.id)}
            onChangeNode=${changeNode}
            onChangeNodeId=${changeNodeId}
            onRemoveNode=${removeNode} />`
    : html`<${MetaInspector} meta=${meta} onChange=${m => { setMeta(m); setDirty(true); }} />`;

  return html`
    <div class="rf-editor">
      <${Toolbar} templates=${templates} activeTemplate=${activeTemplate}
                  onLoad=${loadTemplate} onNew=${newTemplate} onSave=${saveTemplate}
                  onAddNode=${addNode} dirty=${dirty} />
      <div class="rf-editor-body">
        <div class="rf-canvas" ref=${reactFlowWrapper}>
          <${ReactFlow}
            nodes=${nodes}
            edges=${edges}
            nodeTypes=${nodeTypes}
            onNodesChange=${handleNodesChange}
            onEdgesChange=${handleEdgesChange}
            onConnect=${onConnect}
            onNodeClick=${onNodeClick}
            onPaneClick=${onPaneClick}
            fitView=${nodes.length > 0}
            fitViewOptions=${{ padding: 0.18, includeHiddenNodes: false }}
            proOptions=${{ hideAttribution: true }}
            defaultEdgeOptions=${{ style: { stroke: '#64748b', strokeWidth: 1.5 } }}
            deleteKeyCode=${['Delete', 'Backspace']}>
            <${Background} gap=${24} size=${1} color="#cbd5e1" />
            <${Controls} showInteractive=${false} />
            <${MiniMap} pannable zoomable nodeColor=${node => NODE_PALETTE[node.data?.dagType]?.stroke || '#94a3b8'}
                        style=${{ background: '#f8fafc' }} />
          </${ReactFlow}>
        </div>
        <aside class="rf-inspector">
          ${inspector}
        </aside>
      </div>
    </div>
  `;
}

export function mountEditor() {
  const target = document.querySelector('#editorRoot');
  if (!target) return null;
  target.innerHTML = '';
  const root = createRoot(target);
  root.render(html`<${ReactFlowProvider}><${DagEditorApp} /></${ReactFlowProvider}>`);
  return root;
}

// Auto-mount when module loads. If the user navigates to /editor later, the React tree
// is already mounted (the container is in the SPA).
mountEditor();
