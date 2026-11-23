import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadData } from '../tools/lib/loader.mjs';
import { assessRequest, resourceConflicts, scenarioMinutes } from '../tools/lib/feasibility.mjs';
import { assessReachability, allocateSlots, evaluateOption, mergeSessions, simulatePreemption } from '../tools/lib/plan.mjs';
import { summarizeAreas, overallSummary, sensitivityTableSync } from '../tools/lib/stats.mjs';
import { buildReferralLedger, requestsWithoutReferral } from '../tools/lib/referrals.mjs';
import { buildReport, buildPublicSummary, SCENARIOS } from '../tools/lib/report.mjs';
import { ingestWeek } from '../tools/lib/intake.mjs';
import { toMinutes, formatMinutes } from '../tools/lib/time.mjs';

const dir = pathToFileURL(new URL('../fixtures/', import.meta.url).pathname);

async function data() {
  return loadData(dir);
}

test('时间换算以 18:00 为锚点，半开窗口边界正确', () => {
  assert.equal(toMinutes('18:00'), 0);
  assert.equal(toMinutes('17:00'), -60);
  assert.equal(toMinutes('21:00'), 180);
  assert.equal(formatMinutes(-60), '17:00');
  assert.equal(formatMinutes(180), '21:00');
});

test('same 组合不能拆成多次覆盖：R1 的 advice|lab 在 P1 停用后无同点替代', async () => {
  const d = await data();
  const r1 = d.requests.find(r => r.id === 'R1');
  const result = assessRequest(r1, d.sessions, d.journeys);
  assert.equal(result.feasible, false);
  // P2 虽有 identity/advice，但没有同点 lab，不允许凑成覆盖。
  assert.ok(result.reasons.length > 0);
  // P2 虽有 identity/advice，但没有同点 lab，不允许凑成覆盖。
  assert.ok(result.reasons.some(reason => reason.includes('same 组合不允许拆点')));
});

test('split 组合按事项顺序并留出行程时间：缺方向行程不默认可达', async () => {
  const d = await data();
  // R3 需要 advice|lab，B->P1 之后还需 P1->P3，但 split 路径里任一缺方向即失败。
  const r3 = d.requests.find(r => r.id === 'R3');
  const result = assessRequest(r3, d.sessions, d.journeys);
  assert.equal(result.feasible, false);
});

test('半开窗口与完整办理用时：R5 差两分钟不可达', async () => {
  const d = await data();
  const r5 = d.requests.find(r => r.id === 'R5');
  const result = assessRequest(r5, d.sessions, d.journeys);
  assert.equal(result.feasible, false);
  // C->P3 22 分钟 + lab 40 分钟 = 62，窗口只有 60 分钟（18:00..19:00）。
  assert.ok(result.reasons[0].includes('办结62'));
});

test('可行方案返回完整证据链：到场、开始、办结时刻与行程耗时', async () => {
  const d = await data();
  const r4 = d.requests.find(r => r.id === 'R4');
  const result = assessRequest(r4, d.sessions, d.journeys);
  assert.equal(result.feasible, true);
  assert.deepEqual(result.plan.map(p => p.session), ['S3']);
  const step = result.plan[0];
  assert.equal(step.travel, 19); // B->P2 18:00 后耗时
  assert.equal(step.arrive, 29);
  assert.equal(step.finish, 49);
});

test('18:00 前后行程取不同耗时列', async () => {
  const d = await data();
  const journey = d.journeys.get('A->P1');
  assert.equal(scenarioMinutes(journey, -30, 'observed'), 16); // 严格早于 18:00
  assert.equal(scenarioMinutes(journey, 0, 'observed'), 20);
  assert.equal(scenarioMinutes(journey, 30, 'observed'), 20);
});

test('半开窗口边界：办结时刻恰好等于窗口终点时不可达，放宽一分钟才可达', () => {
  const sessions = [{ id: 'S4', point: 'P3', day: 4, type: 'lab', from: 0, to: 90, minutes: 40, slots: 1, resource: 'L1', effective: true }];
  const journeys = new Map([['C->P3', { from: 'C', to: 'P3', from18: 22, before18: 20 }]]);
  const atEdge = { id: 'T', area: 'C', weight: 1, needed: ['lab'], combine: 'same', windowFrom: 0, windowTo: 62 };
  assert.equal(assessRequest(atEdge, sessions, journeys).feasible, false);
  const relaxed = { ...atEdge, windowTo: 63 };
  assert.equal(assessRequest(relaxed, sessions, journeys).feasible, true);
});

test('交通情景：R5 在 tight(-10%) 翻转为可达，observed/slack 不可达', async () => {
  const d = await data();
  const r5 = d.requests.find(r => r.id === 'R5');
  const tight = assessRequest(r5, d.sessions, d.journeys, 'tight');
  const slack = assessRequest(r5, d.sessions, d.journeys, 'slack');
  assert.equal(tight.feasible, true);  // 22*0.9=19.8→19，19+40=59 < 60
  assert.equal(slack.feasible, false); // 22*1.1=24.2→25，25+40=65
});

test('装修停用：P1 的 S1/S2 无效，基准排期只含 S3/S4', async () => {
  const d = await data();
  const suspended = d.sessions.filter(s => !s.effective).map(s => s.id).sort();
  assert.deepEqual(suspended, ['S1', 'S2', 'S5', 'S6']);
  const baseline = d.sessions.filter(s => s.effective).map(s => s.id).sort();
  assert.deepEqual(baseline, ['S3', 'S4']);
});

test('资源并发校验：O3 恢复 P1 后与 S3/S4 冲突，容量均为 1', async () => {
  const d = await data();
  const o3 = d.options.find(o => o.id === 'O3');
  const merged = mergeSessions(d.sessions, o3, d.rawSessions);
  const conflicts = resourceConflicts(merged, d.resourceCapacity);
  const resources = conflicts.map(c => c.resource).sort();
  assert.deepEqual(resources, ['L1', 'T1']);
  assert.ok(conflicts.every(c => c.capacity === 1));
});

test('同场次重复出现只计一份容量：O1 的 S4 不新增席位，S6 无权重增益', async () => {
  const d = await data();
  const o1 = d.options.find(o => o.id === 'O1');
  const evaluation = evaluateOption(o1, d);
  assert.deepEqual(evaluation.duplicatedSessions, ['S4']);
  const s4Copies = evaluation.sessions.filter(s => s.id === 'S4');
  assert.equal(s4Copies.length, 1);
  assert.equal(s4Copies[0].slots, 1); // 仍是原始一份容量
  // S6 服务的 identity 需求已被 S3 覆盖，O1 的可达权重与基准同为 30。
  const reachWeight = evaluation.reachability.filter(r => r.feasible).reduce((s, r) => s + r.weight, 0);
  assert.equal(reachWeight, 30);
});

test('方案评估：O2 无资源冲突且三个片区均越过 0.4 保障底线', async () => {
  const d = await data();
  const report = await buildReport(dir);
  const o2 = report.options.find(o => o.option === 'O2');
  assert.equal(o2.feasible, true);
  assert.deepEqual(o2.resourceConflicts, []);
  assert.ok(o2.areaRates.every(a => a.meetsFloor));
  assert.ok(o2.reachGain > 0);
});

test('让位模拟：O3 优先时挤停基准 S3、S4，并量化挤掉的可办机会', async () => {
  const d = await data();
  const o3 = d.options.find(o => o.id === 'O3');
  const sim = simulatePreemption(o3, d);
  assert.deepEqual(sim.preempted.sort(), ['S3', 'S4']);
  // 挤停后 identity 与 lab 的基准席位消失，覆盖权重低于无冲突方案。
  assert.ok(sim.allocation.coveredIds.length <= 2);
});

test('容量分配按接待条数计，weight 仅用于加权估计', async () => {
  const d = await data();
  const reach = assessReachability(d.requests, d.sessions, d.journeys);
  const allocation = allocateSlots(d.requests, reach, d.sessions);
  // S3 三个席位、S4 一个席位，满排后共安排 4 条记录。
  assert.equal(allocation.coveredIds.length, 4);
  assert.equal(allocation.remainingSlots.S3, 0);
  assert.equal(allocation.remainingSlots.S4, 0);
  const overall = overallSummary(d.requests, reach, allocation);
  assert.equal(overall.coveredRecords, 4);
});

test('分区统计基于需求而非到访记录，并给出有效样本量与抑制判断', async () => {
  const d = await data();
  const reach = assessReachability(d.requests, d.sessions, d.journeys);
  const allocation = allocateSlots(d.requests, reach, d.sessions);
  const areas = summarizeAreas(d.requests, reach, allocation, d.populations, d.limits.disclosureMinPeople);
  const byArea = Object.fromEntries(areas.map(a => [a.area, a]));
  assert.equal(byArea.A.totalWeight, 26);
  assert.equal(byArea.B.totalWeight, 32);
  assert.equal(byArea.C.totalWeight, 36);
  // 每区 9-11 条记录，高于披露线 3，本数据不触发公开抑制。
  assert.ok(areas.every(a => a.publicSuppressed === false));
  assert.ok(areas.every(a => a.effectiveSampleSize > 0));
});

test('小样本片区触发抑制：构造仅两条记录的片区', () => {
  const requests = [
    { id: 'X1', area: 'Z', weight: 5, needed: ['advice'], combine: 'split' },
    { id: 'X2', area: 'Z', weight: 5, needed: ['lab'], combine: 'split' },
  ];
  const reachability = [
    { request: 'X1', area: 'Z', weight: 5, feasible: true, plan: [], reasons: [] },
    { request: 'X2', area: 'Z', weight: 5, feasible: false, plan: [], reasons: ['x'] },
  ];
  const populations = new Map([['Z', { eligible: 20, responses: 2, version: 'Q2' }]]);
  const areas = summarizeAreas(requests, reachability, { coveredIds: ['X1'] }, populations, 3);
  assert.equal(areas[0].publicSuppressed, true);
  assert.ok(areas[0].suppressionReasons.some(r => r.includes('披露线')));
});

test('转介台账区分「转介未办成」与「尚无人申请」，通知不假定收回', async () => {
  const d = await data();
  const reach = assessReachability(d.requests, d.sessions, d.journeys);
  const byId = new Map(reach.map(r => [r.request, r]));
  const ledger = buildReferralLedger(d, byId);
  const f1 = ledger.find(r => r.referral === 'F1');
  assert.equal(f1.state, 'referred_unfinished');
  assert.equal(f1.currentlyReachable, false);
  assert.ok(f1.obligations.some(o => o.includes('通知未收回')));
  const f3 = ledger.find(r => r.referral === 'F3');
  assert.equal(f3.state, 'done'); // completed 仅作覆盖事实
  const noReferral = requestsWithoutReferral(d);
  assert.equal(noReferral.length, 27);
  assert.ok(noReferral.every(r => r.note.includes('不得从到访记录推断')));
});

test('敏感性表标记翻转需求，稳健需求在三种假设下结论一致', async () => {
  const d = await data();
  const table = sensitivityTableSync(d.requests, d.sessions, d.journeys, SCENARIOS);
  const flips = table.filter(r => r.flips);
  assert.deepEqual(flips.map(r => r.request), ['R5']);
  assert.ok(table.filter(r => r.robust).length === 29);
});

test('公开摘要不含需求个案标识与地址类字段，小样本片区只给方向性表述', async () => {
  const report = await buildReport(dir);
  const pub = buildPublicSummary(report);
  const serialized = JSON.stringify(pub);
  // 公开摘要不得出现匿名需求记录号、行程个案或任何地址字段。
  for (const id of ['R1', 'R2', 'D10', 'D11']) {
    assert.ok(!serialized.includes(id), `公开摘要泄露需求记录 ${id}`);
  }
  for (const forbidden of ['address', 'addr', 'location', 'plan', 'reasons']) {
    assert.ok(!serialized.includes(forbidden), `公开摘要出现受限字段 ${forbidden}`);
  }
  assert.ok(pub.options.length === 3);
});

test('周度提交：open 窗口收窄可判定去留，closed 取消当天场次', async () => {
  const d = await data();
  const result = await ingestWeek(d, 'examples/weekly/changes.csv', 'examples/weekly/review.csv');
  assert.equal(result.accepted, true);
  const s4 = result.sessionDecisions.find(x => x.session === 'S4');
  assert.equal(s4.decision, 'keep_adjusted'); // 18:30..19:15 容得下 40 分钟
  const s3 = result.sessionDecisions.find(x => x.session === 'S3');
  assert.equal(s3.decision, 'suspend');
  // 公开视图只有点位级方向，不含请求/转介明细。
  assert.ok(!JSON.stringify(result.publicView).includes('R1'));
});

test('周度提交校验：未知点位与非法结果被拒绝', async () => {
  const d = await data();
  const badChanges = 'point,day,reported_day,first,last,status\nP9,4,6,,,closed\n';
  const badReviews = 'referral,day,result\nF9,6,completed\n';
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/bad-changes.csv', badChanges);
  await fs.writeFile('/tmp/bad-review.csv', badReviews);
  const result = await ingestWeek(d, '/tmp/bad-changes.csv', '/tmp/bad-review.csv');
  assert.equal(result.accepted, false);
  assert.ok(result.errors.some(e => e.includes('P9')));
  assert.ok(result.errors.some(e => e.includes('F9')));
});

test('报告给出预算冲突：所有两两组合均超 100 预算', async () => {
  const report = await buildReport(dir);
  assert.ok(report.bundles.length === 3);
  assert.ok(report.bundles.every(b => b.withinBudget === false));
  for (const option of report.options) assert.equal(option.withinBudget, true);
});

test('保障底线冲突清单定位未达标片区与可修复方案', async () => {
  const report = await buildReport(dir);
  const failing = report.floorConflicts.map(c => c.area).sort();
  assert.deepEqual(failing, ['A', 'C']);
  const cConflict = report.floorConflicts.find(c => c.area === 'C');
  assert.deepEqual(cConflict.optionsThatFix, ['O2']);
});

test('解释链说明同距不同覆盖：含通道耗时差与 R5 的两分钟约束', async () => {
  const report = await buildReport(dir);
  const { explanations } = report;
  assert.ok(explanations.distanceIsNotCoverage.includes('方向行程'));
  assert.ok(explanations.journeyDirection.some(j => j.note.includes('18:00 前后')));
  const r5 = explanations.decisiveCases.find(c => c.request === 'R5');
  assert.equal(r5.feasible, false);
  assert.ok(r5.chain[0].includes('办结62'));
  // 本数据全部通道仅提供单向，反向缺失必须列明。
  assert.ok(explanations.missingDirections.length >= 9);
});

test('O3 让位损失落到需求级：列出失去可达与失去席位的记录及权重', async () => {
  const report = await buildReport(dir);
  const o3 = report.options.find(o => o.option === 'O3');
  assert.ok(o3.preemption.lostReachableRequests.includes('R4'));
  assert.deepEqual(o3.preemption.lostCoveredRequests.sort(), ['D11', 'D12', 'D17', 'D22']);
  assert.equal(o3.preemption.lostCoveredWeight, 11);
});

test('公开摘要可独立成稿且不含内部解释链明细', async () => {
  const report = await buildReport(dir);
  const pub = buildPublicSummary(report);
  const serialized = JSON.stringify(pub);
  assert.ok(!serialized.includes('decisiveCases'));
  assert.ok(!serialized.includes('journeyDirection'));
  assert.equal(pub.sensitivity.flipCount, 1);
});
