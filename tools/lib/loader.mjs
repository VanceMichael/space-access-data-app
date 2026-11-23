// 读取全部交接表，应用街道上报的开放变更，并标注场次来源与点位状态。
import { readFile } from 'node:fs/promises';
import { readCsv, splitList } from './csv.mjs';
import { toMinutes, formatMinutes } from './time.mjs';

export async function loadData(dir) {
  const format = JSON.parse(await readFile(new URL('format.json', dir), 'utf8'));
  const tables = {};
  for (const [name, fields] of Object.entries(format.tables)) {
    tables[name] = await readCsv(new URL(`${name}.csv`, dir), fields);
  }

  const requests = tables.requests.map(row => ({
    id: row.request,
    area: row.area,
    needed: splitList(row.needed),
    windowFrom: toMinutes(row.available_from),
    windowTo: toMinutes(row.available_to),
    combine: row.combine, // same：只能同点连办；split：允许拆点
    weight: Number(row.weight),
  }));

  const rawSessions = tables.services.map(row => ({
    id: row.session,
    point: row.point,
    day: Number(row.day),
    type: row.type,
    from: toMinutes(row.from),
    to: toMinutes(row.to),
    minutes: Number(row.minutes),
    slots: Number(row.slots),
    resource: row.resource,
  }));

  // 被转介单引用的场次属于当前已排期的基准场次；其余只在候选方案里出现。
  const referenced = new Set();
  for (const referral of tables.referrals) {
    for (const id of splitList(referral.sessions)) referenced.add(id);
  }
  const optionSessions = new Set();
  for (const option of tables.options) {
    for (const id of splitList(option.sessions)) optionSessions.add(id);
  }
  for (const session of rawSessions) {
    session.source = referenced.has(session.id)
      ? 'baseline'
      : optionSessions.has(session.id)
        ? 'candidate'
        : 'unassigned';
  }

  const changes = tables.changes.map(row => ({
    point: row.point,
    day: Number(row.day),
    reportedDay: Number(row.reported_day),
    first: row.first === '' ? null : toMinutes(row.first),
    last: row.last === '' ? null : toMinutes(row.last),
    status: row.status, // closed：装修停用；open：开放时段调整
  }));

  // 应用变更：closed 移除该点位当天全部场次；open 按新区间收窄（窗口不兼容则标记）。
  // 基准有效性还要求场次属于当前排期（source=baseline）；候选场次未被方案购买前不开放。
  const changeLog = [];
  const sessions = [];
  for (const session of rawSessions) {
    const inBaseline = session.source === 'baseline';
    const change = changes.find(c => c.point === session.point && c.day === session.day);
    if (!change) {
      sessions.push({
        ...session,
        effective: inBaseline,
        statusNote: inBaseline ? '按表开放' : '候选场次，未被方案购买前不开放',
      });
      continue;
    }
    if (change.status === 'closed') {
      changeLog.push({ session: session.id, effect: 'suspended', reason: `点位 ${change.point} 第 ${change.day} 天装修停用（第 ${change.reportedDay} 天上报）` });
      sessions.push({ ...session, effective: false, statusNote: '装修停用' });
      continue;
    }
    // open：实际可用区间为场次窗口与上报区间的交集，交集容不下完整办理则不可办。
    const from = Math.max(session.from, change.first);
    const to = Math.min(session.to, change.last);
    const usable = inBaseline && to - from >= session.minutes;
    changeLog.push({
      session: session.id,
      effect: usable ? 'window_adjusted' : 'window_incompatible',
      reason: `点位上报开放区间 ${formatMinutes(change.first)}..${formatMinutes(change.last)}，场次窗口收窄为 ${formatMinutes(from)}..${formatMinutes(to)}`,
    });
    sessions.push({ ...session, effective: usable, from, to, statusNote: usable ? '时段调整后可办' : inBaseline ? '调整后窗口容不下办理用时' : '候选场次，未被方案购买前不开放' });
  }

  const journeys = new Map();
  for (const row of tables.journeys) {
    journeys.set(`${row.from}->${row.to}`, {
      from: row.from,
      to: row.to,
      from18: Number(row.minutes_from_18),
      before18: Number(row.minutes_before_18),
    });
  }

  const referrals = tables.referrals.map(row => ({
    id: row.referral,
    request: row.request,
    sessions: splitList(row.sessions),
    noticeDay: Number(row.notice_day),
    status: row.status, // completed：仅作覆盖事实；notified：仍需预留到办理结果
  }));

  const reviewByReferral = new Map();
  for (const row of tables.review) {
    reviewByReferral.set(row.referral, { day: Number(row.day), result: row.result });
  }

  const options = tables.options.map(row => ({
    id: row.option,
    sessions: splitList(row.sessions),
    cost: Number(row.cost),
    announceDay: Number(row.announce_day),
  }));

  const resourceCapacity = new Map();
  for (const row of tables['available-resources']) {
    resourceCapacity.set(`${row.resource}#${row.day}`, Number(row.concurrent_capacity));
  }

  const populations = new Map(tables.populations.map(row => [row.area, {
    eligible: Number(row.eligible_population),
    responses: Number(row.responses),
    version: row.source_version,
  }]));

  const limits = {
    budget: Number(tables.limits[0].budget),
    minAreaCoverage: Number(tables.limits[0].min_area_coverage),
    disclosureMinPeople: Number(tables.limits[0].disclosure_min_people),
  };

  return {
    tables,
    requests,
    sessions,
    rawSessions,
    changes,
    changeLog,
    journeys,
    referrals,
    reviewByReferral,
    options,
    resourceCapacity,
    populations,
    limits,
  };
}

// 取方向行程；未提供方向不默认可达，返回 null。
export function lookupJourney(journeys, from, to) {
  return journeys.get(`${from}->${to}`) ?? null;
}
