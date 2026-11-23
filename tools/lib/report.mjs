// 评审报告装配：内部审议视图保留全部证据链；公开摘要执行样本抑制且不含任何精确地址/个案解释。
import { loadData } from './loader.mjs';
import { assessReachability, allocateSlots, evaluateOption, simulatePreemption } from './plan.mjs';
import { summarizeAreas, overallSummary, sensitivityTableSync } from './stats.mjs';
import { buildReferralLedger, requestsWithoutReferral } from './referrals.mjs';

export const SCENARIOS = ['tight', 'observed', 'slack']; // 交通假设：-10% / 观察值 / +10%

export async function buildReport(dir) {
  const data = await loadData(dir);

  // 基准：应用街道开放变更后的当前有效场次。
  const baseReach = assessReachability(data.requests, data.sessions, data.journeys);
  const baseAllocation = allocateSlots(data.requests, baseReach, data.sessions);
  const reachById = new Map(baseReach.map(r => [r.request, r]));

  const areaStats = summarizeAreas(data.requests, baseReach, baseAllocation, data.populations, data.limits.disclosureMinPeople);
  const overall = overallSummary(data.requests, baseReach, baseAllocation);

  // 方案评估（预算内单选与两两组合）。
  const optionReports = data.options.map(option => {
    const evaluation = evaluateOption(option, data);
    const preemption = simulatePreemption(option, data);
    const areas = summarizeAreas(data.requests, evaluation.reachability, evaluation.allocation, data.populations, data.limits.disclosureMinPeople);
    const overallOption = overallSummary(data.requests, evaluation.reachability, evaluation.allocation);
    const weakBefore = weakestArea(areaStats);
    const weakAfter = weakestArea(areas);
    return {
      option: option.id,
      cost: option.cost,
      withinBudget: option.cost <= data.limits.budget,
      announceDay: option.announceDay,
      addedSessions: evaluation.addedSessions,
      duplicatedSessions: evaluation.duplicatedSessions,
      resourceConflicts: evaluation.resourceConflicts,
      feasible: evaluation.feasible,
      overall: overallOption,
      reachGain: overallOption.reachableWeight - overall.reachableWeight,
      coverageGain: overallOption.coveredWeight - overall.coveredWeight,
      areaRates: areas.map(a => ({ area: a.area, reachRate: a.reachRate, coverageRate: a.coverageRate, meetsFloor: a.reachRate >= data.limits.minAreaCoverage })),
      weakestBefore: weakBefore,
      weakestAfter: weakAfter,
      weakestImproves: weakAfter.rate >= weakBefore.rate,
      preemption: (() => {
        const baseCovered = new Set(baseAllocation.coveredIds);
        const afterCovered = new Set(preemption.allocation.coveredIds);
        const lost = [...baseCovered].filter(id => !afterCovered.has(id));
        const lostWeight = data.requests.filter(r => lost.includes(r.id)).reduce((s, r) => s + r.weight, 0);
        const baseReachSet = new Set(baseReach.filter(r => r.feasible).map(r => r.request));
        const afterReachSet = new Set(preemption.reachability.filter(r => r.feasible).map(r => r.request));
        const lostReach = [...baseReachSet].filter(id => !afterReachSet.has(id));
        return {
          preemptedSessions: preemption.preempted,
          note: preemption.simulationNote,
          remainingConflicts: preemption.remainingConflicts,
          overallIfPreempted: overallSummary(data.requests, preemption.reachability, preemption.allocation),
          lostReachableRequests: lostReach,
          lostCoveredRequests: lost,
          lostCoveredWeight: lostWeight,
        };
      })(),
    };
  });

  const bundles = buildBundles(data, data.limits, overall, areaStats);
  const conflicts = floorConflicts(data, optionReports, areaStats);
  const sensitivity = sensitivityTableSync(data.requests, data.sessions, data.journeys, SCENARIOS);
  const ledger = buildReferralLedger(data, reachById);
  const noReferral = requestsWithoutReferral(data);
  const explanations = buildExplanations(data, baseReach);

  return {
    generatedAt: new Date().toISOString(),
    conventions: {
      timeWindow: '半开 [from, to)，minutes 为完整办理用时',
      combineSame: 'needed 全部事项同点连办，不拆成多次覆盖',
      combineSplit: '允许拆点，按事项顺序并留出行程时间',
      journey: '仅按可观察方向行程判定，缺失方向不默认可达；18:00 前后用不同耗时列',
      capacity: 'slots 按接待条数计，weight 仅用于加权估计；同场次重复出现只计一份容量',
      privacy: '不使用任何精确住址解释点位取舍，公开摘要对小样本片区执行抑制',
    },
    limits: data.limits,
    changes: data.changeLog,
    explanations,
    baseline: {
      overall,
      areas: areaStats,
      reachability: baseReach,
      allocation: baseAllocation,
    },
    options: optionReports,
    bundles,
    floorConflicts: conflicts,
    sensitivity: {
      scenarios: SCENARIOS,
      scenarioNote: 'tight=观察耗时×0.9 向下取整；slack=×1.1 向上取整；robust 表示三种假设下结论一致',
      rows: sensitivity,
      flipCount: sensitivity.filter(r => r.flips).length,
    },
    referrals: {
      ledger,
      requestsWithoutReferralCount: noReferral.length,
      requestsWithoutReferral: noReferral,
    },
    populations: [...data.populations.entries()].map(([area, p]) => ({ area, ...p })),
  };
}

function weakestArea(areas) {
  const picked = [...areas].sort((a, b) => a.reachRate - b.reachRate || a.area.localeCompare(b.area))[0];
  return { area: picked.area, rate: picked.reachRate };
}

function buildBundles(data, limits, baseOverall, baseAreas) {
  const bundles = [];
  const opts = data.options;
  for (let i = 0; i < opts.length; i += 1) {
    for (let j = i + 1; j < opts.length; j += 1) {
      const pair = [opts[i], opts[j]];
      const cost = pair.reduce((sum, o) => sum + o.cost, 0);
      bundles.push({
        options: pair.map(o => o.id),
        cost,
        withinBudget: cost <= limits.budget,
        note: cost > limits.budget ? `超出季度预算 ${cost - limits.budget}，仅作资金权衡参考` : '预算内',
      });
    }
  }
  return bundles;
}

// 解释链：为什么相近的空间距离会产生不同覆盖结论。
// 不输出任何精确住址，只用片区代号、方向行程与开放/窗口事实说明。
function buildExplanations(data, reachability) {
  const journeyRows = [...data.journeys.values()].filter(j => j.from.length === 1);
  return {
    distanceIsNotCoverage: '覆盖结论不取直线距离，而由「方向行程是否可观察 + 18 点前后耗时 + 场次开放区间 + 本人可用窗口 + 办理用时」共同决定',
    journeyDirection: journeyRows.map(j => ({
      corridor: `${j.from}->${j.to}`,
      before18: j.before18,
      after18: j.from18,
      note: j.before18 !== j.from18 ? `同一通道 18:00 前后耗时相差 ${Math.abs(j.from18 - j.before18)} 分钟` : '两时段耗时相同',
    })),
    decisiveCases: reachability
      .filter(r => !r.feasible || r.plan.length > 1)
      .map(r => ({
        request: r.request,
        area: r.area,
        combine: r.combine,
        feasible: r.feasible,
        chain: r.feasible
          ? r.plan.map(step => `${step.point} 场次${step.session}：行程${step.travel}分钟，到场${step.arrive}，办结${step.finish}`)
          : r.reasons,
      })),
    missingDirections: [...data.journeys.keys()]
      .filter(key => {
        const [from, to] = key.split('->');
        return !data.journeys.has(`${to}->${from}`);
      })
      .map(key => ({ corridor: key, note: '反向行程未提供，换乘回程不默认可达' })),
  };
}

// 片区保障底线与承诺转介的冲突清单：不假定通知已收回，给出可替代安排而不是静默取舍。
function floorConflicts(data, optionReports, baseAreas) {
  const floor = data.limits.minAreaCoverage;
  const failingAtBaseline = baseAreas.filter(a => a.reachRate < floor).map(a => a.area);
  const output = [];
  for (const area of failingAtBaseline) {
    const fixes = optionReports.filter(report =>
      report.feasible && report.areaRates.some(a => a.area === area && a.meetsFloor));
    output.push({
      type: 'area_floor',
      area,
      baselineReachRate: baseAreas.find(a => a.area === area).reachRate,
      floor,
      optionsThatFix: fixes.map(r => r.option),
      conflict: fixes.length === 0 ? '没有任何可行方案把该片区拉回保障底线' : null,
    });
  }
  return output;
}

// 公开摘要：抑制小样本/不稳定片区的数值，只保留区间化、方向性表述，删除一切个案明细。
export function buildPublicSummary(report) {
  return {
    generatedAt: report.generatedAt,
    basis: '合成匿名调查与开放排期，抽样权重加权；不含任何个人精确住址或个案解释',
    overall: {
      reachRate: report.baseline.overall.reachRate,
      coverageRate: report.baseline.overall.coverageRate,
      totalWeight: report.baseline.overall.totalWeight,
    },
    areas: report.baseline.areas.map(a => {
      if (a.publicSuppressed) {
        return {
          area: a.area,
          disclosure: 'suppressed',
          reasons: a.suppressionReasons,
          directionOnly: `片区估计由 ${a.sampleRecords} 条回答支撑，仅在内部审议中提供数值，公开材料不发布`,
        };
      }
      return {
        area: a.area,
        reachRate: a.reachRate,
        coverageRate: a.coverageRate,
        meetsFloor: a.reachRate >= report.limits.minAreaCoverage,
        effectiveSampleSize: a.effectiveSampleSize,
      };
    }),
    options: report.options.map(o => ({
      option: o.option,
      cost: o.cost,
      withinBudget: o.withinBudget,
      feasible: o.feasible,
      reachGain: o.reachGain,
      weakestArea: o.weakestAfter,
      conflictSummary: o.resourceConflicts.map(c => `资源 ${c.resource} 同时段重叠 ${c.overlapSessions.join('/')}`),
    })),
    referralObligations: report.referrals.ledger
      .filter(r => r.state !== 'done')
      .map(r => ({ referral: r.referral, state: r.state, obligations: r.obligations })),
    sensitivity: {
      flipCount: report.sensitivity.flipCount,
      robustShare: 1 - report.sensitivity.flipCount / report.sensitivity.rows.length,
      note: '结论按三种交通假设（-10%/观察/+10%）检验，翻转的需求不在公开摘要中断言可达',
    },
  };
}
