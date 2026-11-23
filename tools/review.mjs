// 评审数据应用入口：
//   node tools/review.mjs [数据目录] [输出目录]
// 默认数据目录 fixtures/，输出 dist/。产出内部审议 JSON 与公开摘要 JSON 两份文件。
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildReport, buildPublicSummary } from './lib/report.mjs';

const dataDir = pathToFileURL(`${process.argv[2] ?? 'fixtures'}/`.replace(/\/+$/, '/'));
const outDir = process.argv[3] ?? 'dist';

const report = await buildReport(dataDir);
const publicSummary = buildPublicSummary(report);

await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}/internal-review.json`, JSON.stringify(report, null, 2));
await writeFile(`${outDir}/public-summary.json`, JSON.stringify(publicSummary, null, 2));

const { overall, areas } = report.baseline;
console.log('=== 基准（已应用街道开放变更）===');
console.log(`加权需求 ${overall.totalWeight}：可达 ${overall.reachableWeight}（${(overall.reachRate * 100).toFixed(1)}%），席位覆盖 ${overall.coveredWeight}（${(overall.coverageRate * 100).toFixed(1)}%）`);
for (const a of areas) {
  const flag = a.publicSuppressed ? ' [公开抑制]' : '';
  const floor = a.reachRate >= report.limits.minAreaCoverage ? '达标' : '低于底线';
  console.log(`片区 ${a.area}：可达率 ${(a.reachRate * 100).toFixed(1)}%（${floor}），有效样本量 ${a.effectiveSampleSize}${flag}`);
}
console.log('\n=== 候选方案 ===');
for (const o of report.options) {
  const conflict = o.resourceConflicts.length ? `，资源冲突 ${o.resourceConflicts.map(c => c.overlapSessions.join('/')).join(';')}` : '';
  const dup = o.duplicatedSessions.length ? `，重复场次 ${o.duplicatedSessions.join('、')}（不新增容量）` : '';
  console.log(`${o.option}：成本 ${o.cost}（预算${o.withinBudget ? '内' : '外'}），可达权重 +${o.reachGain}，席位覆盖权重 +${o.coverageGain}，最薄弱片区 ${o.weakestAfter.area}=${(o.weakestAfter.rate * 100).toFixed(1)}%${dup}${conflict}`);
  if (o.preemption.preemptedSessions.length) {
    console.log(`  让位模拟：挤停 ${o.preemption.preemptedSessions.join('、')}；${o.preemption.note}`);
  }
}
console.log('\n=== 转介台账 ===');
for (const r of report.referrals.ledger) {
  console.log(`${r.referral} -> ${r.request}：${r.state}，当前可达=${r.currentlyReachable}`);
}
console.log(`尚无人申请/转介的需求记录：${report.referrals.requestsWithoutReferralCount} 条（不计为无需求）`);
console.log(`\n交通情景翻转需求：${report.sensitivity.flipCount} 条；输出：${outDir}/internal-review.json 与 ${outDir}/public-summary.json`);
console.log(`停用/调整明细：${report.changes.map(c => `${c.session}:${c.effect}`).join('，') || '无'}`);
