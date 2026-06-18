export const ROLE_ALLOWED_TOOLS = {
  planner: [
    'Read',
    'Write',
    'Edit',
    'MultiEdit',
    'Glob',
    'Grep',
    'LS'
  ],
  worker: [
    'Read',
    'Write',
    'Edit',
    'MultiEdit',
    'Glob',
    'Grep',
    'LS',
    'Bash'
  ],
  judge: [
    'Read',
    'Write',
    'Edit',
    'MultiEdit',
    'Glob',
    'Grep',
    'LS'
  ]
};

export function allowedToolsForRole(role, overrides = {}) {
  const configured = overrides?.[role];
  if (Array.isArray(configured)) return configured;
  return ROLE_ALLOWED_TOOLS[role] || ROLE_ALLOWED_TOOLS.worker;
}
