// 需求按「能实际办完的服务组合」度量。
// same：needed 全部事项只能在同一个点连办，不能拆成多次覆盖。
// split：允许拆点办理，但须按事项顺序，两点之间要留出行程时间。
// 时间窗半开 [from, to)；出发时刻严格早于 18:00 用 before_18 耗时，否则用 from_18。
import { lookupJourney } from './loader.mjs';
import { travelAt } from './time.mjs';

// 给定场次集合（已按方案合并、去重、停用过滤），逐条需求搜索可办完的行程方案。
export function assessRequest(request, sessions, journeys, scenario = 'observed') {
  const active = sessions.filter(s => s.effective);
  // state：当前所在位置（片区或点位）与最早可再次出发时刻。
  // allowedPoint：same 组合要求所有事项在同一个点连办，搜索全程锁定该点。
  const dfs = (index, state, steps, blocked, allowedPoint = null) => {
    if (index === request.needed.length) {
      return { feasible: true, steps };
    }
    const neededType = request.needed[index];
    const candidates = active
      .filter(s => s.type === neededType && (allowedPoint === null || s.point === allowedPoint))
      .sort((a, b) => a.id.localeCompare(b.id));

    for (const session of candidates) {
      const move = moveTo(state.location, session.point, state.readyAt, journeys, scenario);
      if (move.reason) {
        blocked.push(move.reason);
        continue;
      }
      const arrive = state.readyAt + move.minutes;
      // 到场后取「到场时刻、场次开场、本人可用起点」的最大值开始办理。
      const start = Math.max(arrive, session.from, request.windowFrom);
      const finish = start + session.minutes;
      // 半开窗口：finish 必须严格早于本人窗口终点，且不晚于场次结束。
      if (start < request.windowFrom || finish >= request.windowTo || finish > session.to) {
        blocked.push(`事项${neededType}@${session.id} 时间不够（到场${arrive}，办结${finish}，窗口止于${request.windowTo}，场次止于${session.to}）`);
        continue;
      }
      const result = dfs(
        index + 1,
        { location: session.point, readyAt: finish },
        [...steps, { order: index + 1, type: neededType, session: session.id, point: session.point, arrive, start, finish, travel: move.minutes }],
        blocked,
        allowedPoint,
      );
      if (result.feasible) return result;
    }
    return { feasible: false, steps };
  };

  const initial = { location: request.area, readyAt: request.windowFrom };
  const samePoint = request.combine === 'same';
  const blocked = [];
  let result;
  if (samePoint) {
    const points = [...new Set(active.map(s => s.point))].sort();
    result = { feasible: false, steps: [] };
    let eligiblePoint = false;
    for (const point of points) {
      const atPoint = active.filter(s => s.point === point);
      if (!request.needed.every(type => atPoint.some(s => s.type === type))) continue;
      eligiblePoint = true;
      const attempt = dfs(0, initial, [], blocked, point);
      if (attempt.feasible) {
        result = attempt;
        break;
      }
    }
    if (!result.feasible && blocked.length === 0) {
      blocked.push(eligiblePoint
        ? '同点连办在时间窗内无法排下全部事项'
        : `没有任何一个开放点位同时提供 ${request.needed.join('、')}，same 组合不允许拆点办理`);
    }
  } else {
    result = dfs(0, initial, [], blocked);
    if (!result.feasible && blocked.length === 0) {
      blocked.push(`开放场次中找不到事项序列 ${request.needed.join(' -> ')} 的可行连办路径`);
    }
  }

  return {
    request: request.id,
    area: request.area,
    weight: request.weight,
    combine: request.combine,
    needed: request.needed,
    feasible: result.feasible,
    plan: result.feasible ? result.steps : [],
    reasons: result.feasible ? [] : dedupe(blocked).slice(0, 6),
  };
}

function moveTo(location, point, readyAt, journeys, scenario) {
  if (location === point) return { minutes: 0 };
  // 片区->点位、点位->点位换乘都要有可观察方向行程支撑，未提供方向不默认可达。
  const journey = lookupJourney(journeys, location, point);
  if (!journey) {
    return { reason: `缺少 ${location}->${point} 的可观察方向行程，不默认可达` };
  }
  return { minutes: scenarioMinutes(journey, readyAt, scenario) };
}

// 交通情景：observed 用观察值；slack +10%（向上取整）；tight -10%（向下取整，不小于1）。
export function scenarioMinutes(journey, departAt, scenario) {
  const observed = travelAt(journey, departAt);
  if (scenario === 'observed') return observed;
  if (scenario === 'slack') return Math.ceil(observed * 1.1);
  if (scenario === 'tight') return Math.max(1, Math.floor(observed * 0.9));
  throw new Error(`未知交通情景：${scenario}`);
}

function dedupe(items) {
  return [...new Set(items)];
}

// 资源并发校验：同一资源同一时刻重叠的有效场次数不得超过 concurrent_capacity。
export function resourceConflicts(sessions, resourceCapacity) {
  const active = sessions.filter(s => s.effective);
  const groups = new Map();
  for (const session of active) {
    const key = `${session.resource}#${session.day}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }
  const conflicts = [];
  for (const [key, group] of groups) {
    const [resource, day] = key.split('#');
    const capacity = resourceCapacity.get(key) ?? 0;
    const sorted = [...group].sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
    // 扫描任意时刻的最大重叠数（半开区间，相邻不重叠）。
    let maxOverlap = 0;
    for (const anchor of sorted) {
      const overlap = sorted.filter(s => s.from < anchor.to && anchor.from < s.to);
      maxOverlap = Math.max(maxOverlap, overlap.length);
      if (overlap.length > capacity) {
        conflicts.push({
          resource,
          day: Number(day),
          at: anchor.id,
          overlapSessions: overlap.map(s => s.id).sort(),
          capacity,
        });
      }
    }
    if (maxOverlap <= capacity) continue;
  }
  return dedupeBy(conflicts, c => `${c.resource}#${c.day}#${c.overlapSessions.join('|')}`);
}

function dedupeBy(items, keyOf) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
