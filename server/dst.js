// 夏令时切换点推算：把“某月第几个星期几的几点几分”落到某一年的具体日期，
// 再给出切换当天在当地被跳过（不存在）与重复出现（同一串数字出现两次）的两段区间。
// 区间都用“当地挂钟读数”表示，与换算时输入的当地时刻同一把尺子，直接比大小即可。

// 某一年某月里第几个星期几的日号；week 取 1 到 4 或 'last'
function ruleDayOfMonth(year, part) {
  if (part.week === 'last') {
    const daysInMonth = new Date(Date.UTC(year, part.month, 0)).getUTCDate();
    const last = new Date(Date.UTC(year, part.month - 1, daysInMonth));
    const back = (last.getUTCDay() - part.weekday + 7) % 7;
    return daysInMonth - back;
  }
  const first = new Date(Date.UTC(year, part.month - 1, 1));
  const offset = (part.weekday - first.getUTCDay() + 7) % 7;
  return 1 + offset + (Number(part.week) - 1) * 7;
}

// 某段切换规则在某一年的当地挂钟读数（用 UTC 刻度承载，只用来比大小，不当瞬间用）
function ruleWallMs(year, part) {
  return Date.UTC(year, part.month - 1, ruleDayOfMonth(year, part), part.hour, part.minute);
}

// 来源时区某一年的两段切换区间；不实行夏令时、规则缺段、差值不为正或年份不在生效区间内时返回 null。
// 规则里的切换时刻按切换前的挂钟读数理解：
// 开始规则把时钟向前拨，gap 段 [切换读数, 切换读数 + 差值) 在当地不存在；
// 结束规则把时钟向后拨，repeat 段 [切换读数 - 差值, 切换读数) 在当地出现两次。
function transitionWindows(zone, year) {
  if (!zone || zone.usesDst !== true || !zone.dstStart || !zone.dstEnd) return null;
  if (!Number.isInteger(zone.offsetMinutes) || !Number.isInteger(zone.dstOffsetMinutes)) return null;
  const gapMinutes = zone.dstOffsetMinutes - zone.offsetMinutes;
  if (gapMinutes <= 0) return null;
  if (year < zone.fromYear) return null;
  if (zone.toYear !== null && zone.toYear !== undefined && year > zone.toYear) return null;
  const gapMs = gapMinutes * 60000;
  const startWallMs = ruleWallMs(year, zone.dstStart);
  const endWallMs = ruleWallMs(year, zone.dstEnd);
  return {
    gapMinutes,
    gap: { startMs: startWallMs, endMs: startWallMs + gapMs },
    repeat: { startMs: endWallMs - gapMs, endMs: endWallMs },
  };
}

// 判定一个当地时刻落在切换日的哪一段：gap 不存在、repeat 出现两次、normal 照常。
// 切换读数可能贴着零点（例如零点整切换），区间会跨到前一天或后一天，
// 所以连同前后两年的切换点一起比对，年底年初的边界才不会漏判。
function classifyLocalTime(zone, year, wallMs) {
  for (const y of [year - 1, year, year + 1]) {
    const windows = transitionWindows(zone, y);
    if (!windows) continue;
    if (wallMs >= windows.gap.startMs && wallMs < windows.gap.endMs) {
      return { kind: 'gap', gapMinutes: windows.gapMinutes, startMs: windows.gap.startMs, endMs: windows.gap.endMs };
    }
    if (wallMs >= windows.repeat.startMs && wallMs < windows.repeat.endMs) {
      return { kind: 'repeat', gapMinutes: windows.gapMinutes, startMs: windows.repeat.startMs, endMs: windows.repeat.endMs };
    }
  }
  return { kind: 'normal' };
}

module.exports = { ruleDayOfMonth, transitionWindows, classifyLocalTime };
