// 街道周度提交入口：
//   node tools/weekly.mjs [数据目录] [变更csv] [反馈csv] [输出目录]
// 变更/反馈 CSV 表头分别与 fixtures/changes.csv、fixtures/review.csv 一致；留空路径表示本周无该类提交。
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadData } from './lib/loader.mjs';
import { ingestWeek } from './lib/intake.mjs';

const dataDir = pathToFileURL(`${process.argv[2] ?? 'fixtures'}/`.replace(/\/+$/, '/'));
const changePath = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : null;
const reviewPath = process.argv[4] && process.argv[4] !== '-' ? process.argv[4] : null;
const outDir = process.argv[5] ?? 'dist';

const data = await loadData(dataDir);
const result = await ingestWeek(data, changePath, reviewPath);

await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}/weekly-internal.json`, JSON.stringify(result, null, 2));
await writeFile(`${outDir}/weekly-public.json`, JSON.stringify({ accepted: result.accepted, errors: result.errors, ...result.publicView }, null, 2));

if (!result.accepted) {
  console.error('提交未通过校验：');
  for (const error of result.errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('周度提交已接受。场次去留：');
  for (const decision of result.sessionDecisions) {
    console.log(`- ${decision.session}（${decision.point}）：${decision.decision}，证据 ${decision.evidence}；${decision.note}`);
  }
  console.log('\n转介证据强度：');
  for (const update of result.referralUpdates) {
    console.log(`- ${update.referral}：${update.state}，${update.evidenceStrength}`);
  }
  console.log(`\n输出：${outDir}/weekly-internal.json 与 ${outDir}/weekly-public.json`);
}
