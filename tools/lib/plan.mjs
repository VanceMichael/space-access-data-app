// 两层口径：
// 可达（reachable）只回答「时间、行程、开放时段下能否实际办完」，不考虑席位；
// 覆盖（covered）是在场次 slots 内实际安排到席位的匿名需求（按接待条数计，weight 仅用于加权估计）。
import { assessRequest, resourceConflicts } from './feasibility.mjs';

export function assessReachability(requests, sessions, journeys, scenario = 'observed') {
  return requests.map(request => assessRequest(request, sessions, journeys, scenario));
}

// 确定性的席位分配（数据量小，规则可审计）：
// 先安排灵活性低的需求（所需场次数多者优先，同值按事项类型数、再按记录号），同场次按记录号。
export function allocateSlots(requests, reachability, sessions) {
  const slotById = new Map(sessions.filter(s => s.effective).map(s => [s.id, s.slots]));
  const feasible = reachability.filter(r => r.feasible);
  const order = feasible
    .map(r => ({ r, request: requests.find(q => q.id === r.request) }))
    .sort((a, b) =>
      b.r.plan.length - a.r.plan.length
      || b.r.needed.length - a.r.needed.length
      || a.request.id.localeCompare(b.request.id));

  const covered = [];
  const unplaced = [];
  for (const { r } of order) {
    const needs = r.plan.map(step => step.session);
    if (needs.every(id => (slotById.get(id) ?? 0) > 0)) {
      for (const id of needs) slotById.set(id, slotById.get(id) - 1);
      covered.push(r);
    } else {
      const tight = needs.filter(id => (slotById.get(id) ?? 0) === 0);
      unplaced.push({ request: r.request, reason: `席位不足：${[...new Set(tight)].join('、')} 已排满` });
    }
  }
  return {
    coveredIds: covered.map(r => r.request),
    unplaced,
    remainingSlots: Object.fromEntries([...slotById].filter(([, left]) => left >= 0)),
  };
}

// 合并基准有效场次与方案新增场次：同场次只保留一份容量（README 明确约定）。
export function mergeSessions(baseSessions, option, allSessions) {
  const ids = new Set(option.sessions);
  const merged = baseSessions.map(s => ({ ...s }));
  const known = new Set(merged.map(s => s.id));
  for (const id of ids) {
    if (known.has(id)) {
      // 已在当前表中的同场次仍只有一份容量；若原是停用/未启用状态，方案购买将其启用。
      const existing = merged.find(s => s.id === id);
      existing.effective = true;
      existing.statusNote = `方案 ${option.id} 启用（同场次不重复计容量）`;
      continue;
    }
    const source = allSessions.find(s => s.id === id);
    if (source) merged.push({ ...source, effective: true, statusNote: `方案 ${option.id} 新增` });
  }
  return merged;
}

export function evaluateOption(option, data) {
  const base = data.sessions;
  const merged = mergeSessions(base, option, data.rawSessions);
  const added = option.sessions.filter(id => !base.some(s => s.id === id && s.effective));
  const duplicated = option.sessions.filter(id => base.some(s => s.id === id && s.effective));
  const conflicts = resourceConflicts(merged, data.resourceCapacity);

  const reachability = assessReachability(data.requests, merged, data.journeys);
  const allocation = allocateSlots(data.requests, reachability, merged);
  return {
    option: option.id,
    cost: option.cost,
    announceDay: option.announceDay,
    addedSessions: added,
    duplicatedSessions: duplicated,
    resourceConflicts: conflicts,
    feasible: conflicts.length === 0,
    reachability,
    allocation,
    sessions: merged,
  };
}

// 冲突让位模拟：方案场次优先取得共用资源，被挤掉的基准场次置为无效后重新评估。
// 结果只作为审议参考，不自动代替排期决定。
export function simulatePreemption(option, data) {
  const evaluation = evaluateOption(option, data);
  if (evaluation.feasible) return { ...evaluation, preempted: [], simulationNote: '无资源冲突，无需让位' };

  const keep = new Set(option.sessions);
  const preempted = [];
  const adjusted = evaluation.sessions.map(session => {
    const involved = evaluation.resourceConflicts.some(c => c.overlapSessions.includes(session.id));
    if (involved && !keep.has(session.id) && session.source === 'baseline') {
      preempted.push(session.id);
      return { ...session, effective: false, statusNote: `冲突让位给方案 ${option.id}` };
    }
    return session;
  });

  const remainingConflicts = resourceConflicts(adjusted, data.resourceCapacity);
  const reachability = assessReachability(data.requests, adjusted, data.journeys);
  const allocation = allocateSlots(data.requests, reachability, adjusted);
  return {
    ...evaluation,
    sessions: adjusted,
    preempted,
    remainingConflicts,
    reachability,
    allocation,
    simulationNote: preempted.length
      ? `模拟方案优先：基准场次 ${preempted.join('、')} 被挤停`
      : '冲突无法仅靠基准场次让位解决',
  };
}
