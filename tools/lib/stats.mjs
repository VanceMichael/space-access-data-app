// 分区域比较的是「可达需求及缺口」，既有到访/转介记录不视为全部需求。
// 调查有抽样权重：weight 是该匿名记录代表的估计人数，覆盖率先按权重加权，
// 再报告设计效应调整后的有效样本量；样本极少片区同时做稳定性与可识别风险判断。
import { assessRequest } from './feasibility.mjs';

export function summarizeAreas(requests, reachability, allocation, populations, disclosureMinPeople) {
  const covered = new Set(allocation.coveredIds);
  const areas = [...new Set(requests.map(r => r.area))].sort();
  return areas.map(area => {
    const rows = requests.filter(r => r.area === area);
    const reachRows = reachability.filter(r => r.area === area && r.feasible);
    const totalWeight = rows.reduce((sum, r) => sum + r.weight, 0);
    const reachWeight = reachRows.reduce((sum, r) => sum + r.weight, 0);
    const coverWeight = reachRows.filter(r => covered.has(r.request)).reduce((sum, r) => sum + r.weight, 0);
    const sampleN = rows.length;
    const meanWeight = totalWeight / sampleN;
    // 有效样本量 n_eff = (Σw)² / Σw²，衡量加权估计稳定性。
    const sumSquares = rows.reduce((sum, r) => sum + r.weight ** 2, 0);
    const effectiveN = totalWeight ** 2 / sumSquares;
    const reachRate = reachWeight / totalWeight;
    const coverRate = coverWeight / totalWeight;
    const pop = populations.get(area);

    // 可识别风险：任一条记录权重达到披露线，意味着片区估计由极少数回答支撑。
    const maxRecordWeight = Math.max(...rows.map(r => r.weight));
    const smallSample = sampleN < disclosureMinPeople;
    const dominance = maxRecordWeight / totalWeight;
    const unstable = effectiveN < disclosureMinPeople || dominance >= 0.4;

    return {
      area,
      sampleRecords: sampleN,
      totalWeight,
      reachableWeight: reachWeight,
      coveredWeight: coverWeight,
      gapWeight: totalWeight - reachWeight,
      capacityGapWeight: reachWeight - coverWeight,
      reachRate,
      coverageRate: coverRate,
      effectiveSampleSize: Number(effectiveN.toFixed(2)),
      meanWeight: Number(meanWeight.toFixed(2)),
      maxRecordWeight,
      dominance: Number(dominance.toFixed(3)),
      smallSample,
      unstable,
      publicSuppressed: smallSample || unstable,
      suppressionReasons: [
        smallSample ? `样本记录 ${sampleN} 条，低于披露线 ${disclosureMinPeople}` : null,
        unstable ? `有效样本量 ${effectiveN.toFixed(2)} 或单条权重占比 ${(dominance * 100).toFixed(1)}% 显示估计不稳定` : null,
      ].filter(Boolean),
      eligiblePopulation: pop?.eligible ?? null,
      surveyResponses: pop?.responses ?? null,
      sourceVersion: pop?.version ?? null,
    };
  });
}

export function overallSummary(requests, reachability, allocation) {
  const covered = new Set(allocation.coveredIds);
  const totalWeight = requests.reduce((sum, r) => sum + r.weight, 0);
  const reachWeight = reachability.filter(r => r.feasible).reduce((sum, r) => sum + r.weight, 0);
  const coverWeight = reachability.filter(r => r.feasible && covered.has(r.request)).reduce((sum, r) => sum + r.weight, 0);
  return {
    requestRecords: requests.length,
    totalWeight,
    reachableRecords: reachability.filter(r => r.feasible).length,
    reachableWeight: reachWeight,
    coveredRecords: covered.size,
    coveredWeight: coverWeight,
    reachRate: Number((reachWeight / totalWeight).toFixed(4)),
    coverageRate: Number((coverWeight / totalWeight).toFixed(4)),
  };
}

// 交通情景对比：对每条需求给出各情景下的可达结论，标记翻转点。
export function sensitivityTableSync(requests, sessions, journeys, scenarios) {
  return requests.map(request => {
    const byScenario = {};
    for (const scenario of scenarios) {
      const result = assessRequest(request, sessions, journeys, scenario);
      byScenario[scenario] = { feasible: result.feasible, plan: result.plan, reasons: result.reasons };
    }
    const flags = Object.values(byScenario).map(s => s.feasible);
    return {
      request: request.id,
      area: request.area,
      weight: request.weight,
      combine: request.combine,
      scenarios: byScenario,
      robust: flags.every(Boolean) || flags.every(f => !f),
      flips: flags.some(Boolean) && flags.some(f => !f),
    };
  });
}
