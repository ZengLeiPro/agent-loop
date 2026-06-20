// 旧 run.json (v1, phases[]) → 新 run shape (v2, nodes[] + phases[] 兼容 view) 的迁移。
//
// 设计：
// - run.schemaVersion === 2 表示已迁移。
// - phases[] 保留为只读派生 view，旧 UI / artifact reader 不受影响。
// - 新增 run.nodes[] 是 DAG 执行器的真实状态来源。
// - 旧 ralph 三相位 (planner / worker-N / judge-N) 映射成 DAG 节点 id：
//   planner → "planner"
//   worker round N → "review-loop[N].worker"
//   judge  round N → "review-loop[N].judge"

export const RUN_SCHEMA_VERSION = 2;

function nodeIdForPhase(phase) {
  if (phase.role === 'planner') return 'planner';
  if (phase.role === 'worker') return `review-loop[${phase.round ?? 0}].worker`;
  if (phase.role === 'judge') return `review-loop[${phase.round ?? 0}].judge`;
  return `${phase.role}-${phase.round ?? 0}`;
}

function phaseToNode(phase) {
  return {
    id: nodeIdForPhase(phase),
    nodeRef: phase.role === 'planner' ? 'planner' : `review-loop.${phase.role}`,
    iteration: phase.role === 'planner' ? 0 : (phase.round ?? 0),
    status: phase.status,
    startedAt: phase.startedAt,
    completedAt: phase.completedAt,
    sessionId: phase.sessionId,
    totalCostUsd: phase.totalCostUsd,
    error: phase.error,
    note: phase.note,
    legacyPhaseId: phase.id,
    legacyRole: phase.role,
    legacyRound: phase.round ?? 0,
    gitBefore: phase.gitBefore,
    gitAfter: phase.gitAfter
  };
}

export function migrateRun(run) {
  if (!run || typeof run !== 'object') return run;
  if (run.schemaVersion === RUN_SCHEMA_VERSION) return run;

  const migrated = { ...run, schemaVersion: RUN_SCHEMA_VERSION };
  if (!Array.isArray(migrated.phases)) migrated.phases = [];
  if (!Array.isArray(migrated.nodes)) {
    migrated.nodes = migrated.phases.map(phaseToNode);
  }
  if (!migrated.template) migrated.template = 'ralph-compound';
  return migrated;
}

// Sync new run.nodes[] to legacy run.phases[] so old UI / artifact code keeps working.
// Called whenever the executor appends/updates a node.
export function derivePhasesFromNodes(nodes = []) {
  return nodes
    .filter(node => node.legacyRole)
    .map(node => ({
      id: node.legacyPhaseId || `${node.legacyRole}-${node.legacyRound ?? 0}`,
      role: node.legacyRole,
      round: node.legacyRound ?? 0,
      status: node.status,
      startedAt: node.startedAt,
      completedAt: node.completedAt,
      sessionId: node.sessionId,
      totalCostUsd: node.totalCostUsd,
      error: node.error,
      note: node.note,
      gitBefore: node.gitBefore,
      gitAfter: node.gitAfter
    }));
}
