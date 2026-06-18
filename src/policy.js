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
