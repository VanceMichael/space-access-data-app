// 转介台账：
// - referrals.status=completed 仅作覆盖事实；notified 仍需预留到办理结果或经办确认更改。
// - review 表是街道回传的已办反馈：completed / unfinished。
// - 通知没有被假定收回：notified 且未办结的转介持续挂账为未兑现承诺。
// - 「已经转介但没有办成」与「尚无人申请」严格区分，后者不出现在转介台账中。
export function buildReferralLedger(data, reachabilityById) {
  return data.referrals.map(referral => {
    const request = data.requests.find(r => r.id === referral.request);
    const review = data.reviewByReferral.get(referral.id) ?? null;
    const sessions = referral.sessions.map(id => data.rawSessions.find(s => s.id === id));
    const suspended = sessions.filter(s => s && !data.sessions.find(x => x.id === s.id)?.effective).map(s => s.id);

    let state;
    if (review?.result === 'completed' || referral.status === 'completed') {
      state = 'done'; // 已办成，仅作覆盖事实
    } else if (review?.result === 'unfinished') {
      state = 'referred_unfinished'; // 已转介但没有办成
    } else {
      state = 'notified_pending'; // 已通知，结果未回传，承诺继续有效
    }

    const reachable = reachabilityById.get(referral.request)?.feasible ?? null;
    const obligations = state === 'done' ? [] : [
      `转介单 ${referral.id}（通知日 ${referral.noticeDay}）承诺的场次 ${referral.sessions.join('、')} 尚未办结，通知未收回，须保留办理义务或给出替代安排`,
      ...(suspended.length ? [`原承诺场次 ${suspended.join('、')} 因停用/时段调整当前不可办，需重新匹配`] : []),
      ...(reachable === false ? ['按当前开放与交通假设，该需求暂无可达路径，替代安排需另行建设'] : []),
    ];

    return {
      referral: referral.id,
      request: referral.request,
      area: request?.area ?? null,
      sessions: referral.sessions,
      noticeDay: referral.noticeDay,
      referralStatus: referral.status,
      review: review ? { day: review.day, result: review.result } : null,
      state,
      currentlyReachable: reachable,
      obligations,
    };
  });
}

// 尚无人申请：在全部转介单中从未出现过的需求记录。
export function requestsWithoutReferral(data) {
  const referred = new Set(data.referrals.map(r => r.request));
  return data.requests.filter(r => !referred.has(r.id)).map(r => ({
    request: r.id,
    area: r.area,
    weight: r.weight,
    note: '尚无人申请/转介，不得从到访记录推断为无需求',
  }));
}
