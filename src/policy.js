// Tool 权限策略：以 agentType（reader/writer/judge）为基础默认；旧 role 名（planner/worker/judge）
// 作为别名映射，保留向后兼容。
//
// 设计原则：
// - reader 与 judge：只读 + 写本地工件（不许 Bash）；
// - writer：完整集（含 Bash），承担真实工程修改。

const READER_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS'];
const WRITER_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'Bash'];
const JUDGE_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS'];

export const AGENT_TYPE_ALLOWED_TOOLS = {
  reader: READER_TOOLS,
  writer: WRITER_TOOLS,
  judge: JUDGE_TOOLS
};

// 旧 role → agentType 映射（向后兼容 runner.js / overrides 配置）。
export const ROLE_TO_AGENT_TYPE = {
  planner: 'reader',
  worker: 'writer',
  judge: 'judge'
};

// 兼容旧 API：按 role 取 allowed tools，等价于按对应 agentType 取。
export const ROLE_ALLOWED_TOOLS = {
  planner: READER_TOOLS,
  worker: WRITER_TOOLS,
  judge: JUDGE_TOOLS
};

export function allowedToolsForAgentType(agentType, overrides = {}) {
  const configured = overrides?.[agentType];
  if (Array.isArray(configured)) return configured;
  return AGENT_TYPE_ALLOWED_TOOLS[agentType] || [];
}

export function allowedToolsForRole(role, overrides = {}) {
  const configured = overrides?.[role];
  if (Array.isArray(configured)) return configured;
  if (!ROLE_ALLOWED_TOOLS[role]) return [];
  return ROLE_ALLOWED_TOOLS[role];
}

export function isDangerousPermissionMode(permissionMode) {
  return permissionMode === 'bypassPermissions';
}

export function assertPermissionModeAllowed(permissionMode, { allowDangerous = process.env.AGENT_LOOP_ALLOW_BYPASS_PERMISSIONS === 'true' } = {}) {
  if (isDangerousPermissionMode(permissionMode) && !allowDangerous) {
    const error = new Error('bypassPermissions requires AGENT_LOOP_ALLOW_BYPASS_PERMISSIONS=true.');
    error.statusCode = 403;
    throw error;
  }
}
