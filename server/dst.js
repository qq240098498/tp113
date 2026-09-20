// 夏令时规则的落地：把"第几个星期几的几点几分"算成具体年份的切换点，
// 再据此判断某个当地时刻是正常、不存在（切换当天时钟向前拨快跳过的一段）
// 还是重复（切换当天时钟向后拨回、同一串数字出现两次的一段）
const MINUTE_MS = 60000;

// 第几个（或最后一个）星期几落在当月的几号
function ruleDayOfMonth(year, part) {
  if (part.week === 'last') {
    const lastDay = new Date(Date.UTC(year, part.month, 0)).getUTCDate();
    const lastDow = new Date(Date.UTC(year, part.month - 1, lastDay)).getUTCDay();
    return lastDay - ((lastDow - part.weekday + 7) % 7);
  }
  const firstDow = new Date(Date.UTC(year, part.month - 1, 1)).getUTCDay();
  return 1 + ((part.weekday - firstDow + 7) % 7) + (Number(part.week) - 1) * 7;
}

// 这条档案的夏令时规则是否真的能落地：开关、两段规则与更靠前的夏令时偏移缺一不可
function dstCapable(zone) {
  return Boolean(zone && zone.usesDst && zone.dstStart && zone.dstEnd
    && Number.isInteger(zone.dstOffsetMinutes) && zone.dstOffsetMinutes > zone.offsetMinutes);
}

// 某一年的两次切换。开始时刻按标准偏移折算（切换前执行标准时），
// 结束时刻按夏令时偏移折算（切换前执行夏令时）；生效年份之外的年份没有切换
function transitionsForYear(zone, year) {
  if (!dstCapable(zone)) return null;
  if (year < zone.fromYear || (zone.toYear !== null && year > zone.toYear)) return null;
  const startDay = ruleDayOfMonth(year, zone.dstStart);
  const startLocalMs = Date.UTC(year, zone.dstStart.month - 1, startDay, zone.dstStart.hour, zone.dstStart.minute);
  const endDay = ruleDayOfMonth(year, zone.dstEnd);
  const endLocalMs = Date.UTC(year, zone.dstEnd.month - 1, endDay, zone.dstEnd.hour, zone.dstEnd.minute);
  return {
    year,
    startLocalMs,
    startUtcMs: startLocalMs - zone.offsetMinutes * MINUTE_MS,
    endLocalMs,
    endUtcMs: endLocalMs - zone.dstOffsetMinutes * MINUTE_MS,
  };
}

// 某一年贡献的夏令时实行区间（基准时刻口径，左闭右开）。
// 开始早于结束（北半球）就是当年的一段；开始晚于结束（南半球跨年）要拼上后一年的结束切换，
// 后一年的结束切换不存在（例如规则已到期）时这一段夏令时不成立
function dstIntervalsForYear(zone, year) {
  const found = transitionsForYear(zone, year);
  if (!found) return [];
  if (found.startLocalMs < found.endLocalMs) {
    return [{ from: found.startUtcMs, to: found.endUtcMs }];
  }
  const next = transitionsForYear(zone, year + 1);
  if (!next) return [];
  return [{ from: found.startUtcMs, to: next.endUtcMs }];
}

// 某个基准时刻这条档案实际使用的偏移
function offsetAt(zone, utcMs) {
  if (!dstCapable(zone)) return zone.offsetMinutes;
  const year = new Date(utcMs).getUTCFullYear();
  for (let index = -1; index <= 1; index += 1) {
    const spans = dstIntervalsForYear(zone, year + index);
    for (const span of spans) {
      if (utcMs >= span.from && utcMs < span.to) return zone.dstOffsetMinutes;
    }
  }
  return zone.offsetMinutes;
}

// 不存在的那一段：从开始切换的当地时刻起，到拨快后的当地时刻止（左闭右开）
function gapIntervalFor(zone, localMs) {
  const shiftMs = (zone.dstOffsetMinutes - zone.offsetMinutes) * MINUTE_MS;
  const year = new Date(localMs).getUTCFullYear();
  for (let index = -1; index <= 1; index += 1) {
    const found = transitionsForYear(zone, year + index);
    if (!found) continue;
    if (localMs >= found.startLocalMs && localMs < found.startLocalMs + shiftMs) {
      return { startLocalMs: found.startLocalMs, endLocalMs: found.startLocalMs + shiftMs };
    }
  }
  return null;
}

// 判断一个当地时刻站不站得住：标准偏移与夏令时偏移各折算出一个候选基准时刻，
// 哪个候选落回自己的偏移哪个就算数。两个都算数说明同一串数字出现两次（第一次
// 按夏令时、第二次按标准时）；都不算数说明这一段被时钟向前拨没了
function classifyLocal(zone, localMs) {
  if (!dstCapable(zone)) {
    return { kind: 'normal', offsetMinutes: zone.offsetMinutes, utcMs: localMs - zone.offsetMinutes * MINUTE_MS };
  }
  const standard = zone.offsetMinutes;
  const daylight = zone.dstOffsetMinutes;
  const standardUtcMs = localMs - standard * MINUTE_MS;
  const daylightUtcMs = localMs - daylight * MINUTE_MS;
  const standardValid = offsetAt(zone, standardUtcMs) === standard;
  const daylightValid = offsetAt(zone, daylightUtcMs) === daylight;
  if (standardValid && daylightValid) {
    return {
      kind: 'overlap',
      first: { offsetMinutes: daylight, utcMs: daylightUtcMs },
      second: { offsetMinutes: standard, utcMs: standardUtcMs },
    };
  }
  if (daylightValid) return { kind: 'normal', offsetMinutes: daylight, utcMs: daylightUtcMs };
  if (standardValid) return { kind: 'normal', offsetMinutes: standard, utcMs: standardUtcMs };
  return { kind: 'gap', gap: gapIntervalFor(zone, localMs) };
}

module.exports = {
  ruleDayOfMonth,
  dstCapable,
  transitionsForYear,
  dstIntervalsForYear,
  offsetAt,
  classifyLocal,
};
