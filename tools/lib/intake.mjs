// 街道周度提交接收：开放变更（changes 同构）与已办反馈（review 同构）。
// 输出每个场次的去留建议与证据强度，公开摘要与内部审议看到的粒度不同。
import { readFile } from 'node:fs/promises';
import { parseTable, splitList } from './csv.mjs';
import { toMinutes, formatMinutes } from './time.mjs';

const CHANGE_FIELDS = ['point', 'day', 'reported_day', 'first', 'last', 'status'];
const REVIEW_FIELDS = ['referral', 'day', 'result'];

export async function ingestWeek(data, changePath = null, reviewPath = null) {
  const incomingChanges = changePath
    ? parseTable(await readFile(changePath, 'utf8'), CHANGE_FIELDS, '周度开放变更').map(row => ({
      point: row.point,
      day: Number(row.day),
      reportedDay: Number(row.reported_day),
      first: row.first === '' ? null : toMinutes(row.first),
      last: row.last === '' ? null : toMinutes(row.last),
      status: row.status,
    }))
    : [];
  const incomingReviews = reviewPath
    ? parseTable(await readFile(reviewPath, 'utf8'), REVIEW_FIELDS, '周度已办反馈').map(row => ({
      referral: row.referral,
      day: Number(row.day),
      result: row.result,
    }))
    : [];

  const errors = [];
  const knownPoints = new Set(data.sessions.map(s => s.point));
  const knownReferrals = new Set(data.referrals.map(r => r.id));
  for (const change of incomingChanges) {
    if (!knownPoints.has(change.point)) errors.push(`变更点位 ${change.point} 不在已知点位清单`);
    if (!['closed', 'open'].includes(change.status)) errors.push(`变更状态 ${change.status} 不支持（仅 closed/open）`);
    if (change.status === 'open' && (change.first === null || change.last === null)) errors.push(`点位 ${change.point} 的 open 变更必须给出 first/last`);
    if (change.first !== null && change.last !== null && change.last <= change.first) errors.push(`点位 ${change.point} 的开放区间不是有效半开区间`);
  }
  for (const review of incomingReviews) {
    if (!knownReferrals.has(review.referral)) errors.push(`反馈转介单 ${review.referral} 无对应台账记录`);
    if (!['completed', 'unfinished'].includes(review.result)) errors.push(`反馈结果 ${review.result} 不支持（仅 completed/unfinished）`);
  }

  // 场次去留：closed 直接停；open 按新区间逐场核对能否容纳完整办理用时。
  const sessionDecisions = [];
  for (const session of data.rawSessions) {
    const change = incomingChanges.find(c => c.point === session.point && c.day === session.day);
    if (!change) {
      sessionDecisions.push({ session: session.id, point: session.point, decision: 'keep', evidence: 'no_change', note: '本周无变更，维持现行排期' });
      continue;
    }
    if (change.status === 'closed') {
      sessionDecisions.push({ session: session.id, point: session.point, decision: 'suspend', evidence: 'point_closed', note: `第 ${change.reportedDay} 天上报停用，第 ${change.day} 天场次取消` });
      continue;
    }
    const from = Math.max(session.from, change.first);
    const to = Math.min(session.to, change.last);
    const usable = to - from >= session.minutes;
    sessionDecisions.push({
      session: session.id,
      point: session.point,
      decision: usable ? 'keep_adjusted' : 'suspend_window',
      evidence: usable ? 'window_compatible' : 'window_too_tight',
      note: usable ? `收窄至窗口 ${formatMinutes(from)}..${formatMinutes(to)} 仍可办完 ${session.minutes} 分钟` : `窗口 ${formatMinutes(from)}..${formatMinutes(to)} 容不下 ${session.minutes} 分钟办理`,
    });
  }

  // 证据强度：completed 是直接办理事实（强）；unfinished 是未办成事实（强，但指向缺口）；
  // 无反馈的 notified 仅为流程状态（弱），不得在公开材料里表述为已服务。
  const referralUpdates = data.referrals.map(referral => {
    const feedback = incomingReviews.find(r => r.referral === referral.id);
    const prior = data.reviewByReferral.get(referral.id) ?? null;
    const effective = feedback ?? prior;
    let evidenceStrength;
    let state;
    if (effective?.result === 'completed' || referral.status === 'completed') {
      evidenceStrength = 'strong';
      state = 'done';
    } else if (effective?.result === 'unfinished') {
      evidenceStrength = 'strong';
      state = 'referred_unfinished';
    } else {
      evidenceStrength = 'weak';
      state = 'notified_pending';
    }
    return {
      referral: referral.id,
      request: referral.request,
      state,
      evidenceStrength,
      newFeedback: feedback,
      note: evidenceStrength === 'weak' ? '仅有通知流程状态，无办理事实，公开摘要不声称已服务' : '有办理结果事实支撑',
    };
  });

  return {
    accepted: errors.length === 0,
    errors,
    incomingChanges,
    incomingReviews,
    sessionDecisions,
    referralUpdates,
    publicView: {
      // 公开视图只给场次级去留方向和强证据计数，不给请求/转介个案。
      sessionDirections: sessionDecisions.map(d => ({ point: d.point, decision: d.decision })),
      strongEvidenceCount: referralUpdates.filter(r => r.evidenceStrength === 'strong').length,
      pendingCount: referralUpdates.filter(r => r.evidenceStrength === 'weak').length,
    },
  };
}

// 便捷方法：把已接受的周度变更合并进下一轮数据目录（由调用方负责落盘）。
export function mergedChangeRows(data, incomingChanges) {
  const index = new Map(data.changes.map(c => [`${c.point}#${c.day}`, c]));
  for (const change of incomingChanges) index.set(`${change.point}#${change.day}`, change);
  return [...index.values()].map(c => ({
    point: c.point,
    day: c.day,
    reported_day: c.reportedDay,
    first: c.first === null ? '' : formatMinutes(c.first),
    last: c.last === null ? '' : formatMinutes(c.last),
    status: c.status,
  }));
}

export { splitList };
