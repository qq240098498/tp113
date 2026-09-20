const { load, WEEKDAY_NAMES } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');
const { classifyLocal, offsetAt } = require('./dst');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86400000;

const pad = (num) => String(num).padStart(2, '0');

// 日期要真存在，例如 2026-02-30 这种不能算数
function validateDate(value) {
  const date = pickText(value);
  if (!date) throw new ApiError(400, 'DATE_REQUIRED', '请填写日期', 'date');
  if (!DATE_PATTERN.test(date)) {
    throw new ApiError(400, 'DATE_INVALID', '日期要写成四位年加短横线加两位月日，例如 2026-09-20', 'date');
  }
  const [year, month, day] = date.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，请检查月份与日', 'date');
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，例如二月没有三十号', 'date');
  }
  return { text: date, year, month, day };
}

function validateTime(value) {
  const time = pickText(value);
  if (!time) throw new ApiError(400, 'TIME_REQUIRED', '请填写时刻', 'time');
  if (!TIME_PATTERN.test(time)) {
    throw new ApiError(400, 'TIME_INVALID', '时刻要写成两位小时加冒号加两位分钟，例如 09:30', 'time');
  }
  const [hour, minute] = time.split(':').map(Number);
  return { text: time, hour, minute };
}

// 重复出现的时刻要指明按第几次出现换算，只能是一或二；留空时按第一次
function validateOccurrence(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (num !== 1 && num !== 2) {
    throw new ApiError(400, 'OCCURRENCE_INVALID', '重复出现的时刻只能按第一次或第二次出现换算', 'occurrence');
  }
  return num;
}

// 把一毫秒数按基准口径拆成日期与时刻两串，当地墙钟与基准时刻都靠它
function wallParts(ms) {
  const at = new Date(ms);
  return {
    date: `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`,
    time: `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`,
  };
}

// 时差写法：整小时只写小时，带分钟的把分钟也写出来
function diffText(minutes) {
  if (minutes === 0) return '与源时区相同';
  const sign = minutes > 0 ? '早' : '晚';
  const abs = Math.abs(minutes);
  const hour = Math.floor(abs / 60);
  const minute = abs % 60;
  const parts = [];
  if (hour) parts.push(`${hour} 小时`);
  if (minute) parts.push(`${minute} 分`);
  return `比源时区${sign} ${parts.join(' ')}`;
}

function dayOffsetText(dayOffset) {
  if (dayOffset === 0) return '同日';
  if (dayOffset > 0) return `后 ${dayOffset} 天`;
  return `前 ${Math.abs(dayOffset)} 天`;
}

// 切换日边界说明：不存在的时刻给出跳过的区间；重复的时刻给出两次出现各自
// 对应的基准瞬间，两次是不同的瞬间；正常时刻只标个正常
function buildBoundary(source, classified) {
  if (classified.kind === 'gap') {
    const gap = classified.gap;
    const start = gap ? wallParts(gap.startLocalMs) : null;
    const end = gap ? wallParts(gap.endLocalMs) : null;
    const beforeOffsetText = offsetText(source.offsetMinutes);
    const afterOffsetText = offsetText(source.dstOffsetMinutes);
    return {
      kind: 'gap',
      message: start && end
        ? `这个时刻在来源时区不存在：${start.date} 当天时钟从 ${start.time} 直接拨到 ${end.time}（${beforeOffsetText} 换成 ${afterOffsetText}），${start.time} 至 ${end.time} 这一段在当地不会出现`
        : '这个时刻在来源时区不存在：切换当天时钟向前拨快，这一段在当地不会出现',
      gap: start && end ? {
        startDate: start.date,
        startTime: start.time,
        endDate: end.date,
        endTime: end.time,
        beforeOffsetText,
        afterOffsetText,
        shiftMinutes: source.dstOffsetMinutes - source.offsetMinutes,
      } : null,
      occurrences: null,
    };
  }
  if (classified.kind === 'overlap') {
    const occurrence = (item, order) => ({
      order,
      offsetMinutes: item.offsetMinutes,
      offsetText: offsetText(item.offsetMinutes),
      dstActive: item.offsetMinutes === source.dstOffsetMinutes,
      standard: wallParts(item.utcMs),
    });
    const occurrences = [occurrence(classified.first, 1), occurrence(classified.second, 2)];
    return {
      kind: 'overlap',
      message: `这个时刻在来源时区会出现两次：第一次按夏令时 ${occurrences[0].offsetText} 算，对应基准 ${occurrences[0].standard.date} ${occurrences[0].standard.time}；第二次按标准时 ${occurrences[1].offsetText} 算，对应基准 ${occurrences[1].standard.date} ${occurrences[1].standard.time}，两次对应不同的瞬间`,
      gap: null,
      occurrences,
    };
  }
  return { kind: 'normal', message: '', gap: null, occurrences: null };
}

// 换算：先把输入时刻按来源时区当年的实际偏移折算成基准时刻，再逐个时区按各自的实际偏移落地。
// 输入时刻落在切换当天被跳过的一段时没有基准时刻可算，换算结果留空，只带回边界说明
function convert(options) {
  const input = options && typeof options === 'object' ? options : {};
  const date = validateDate(input.date);
  const time = validateTime(input.time);
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择来源时区', 'zoneId');
  const occurrence = validateOccurrence(input.occurrence);

  const data = load();
  const source = data.zones.find((item) => item.id === zoneId);
  if (!source) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过', 'zoneId');

  const localMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const baseDay = Math.floor(localMs / DAY_MS);
  const classified = classifyLocal(source, localMs);
  const boundary = buildBoundary(source, classified);

  let utcMs = null;
  let sourceOffset = null;
  let occurrenceUsed = null;
  if (classified.kind === 'normal') {
    sourceOffset = classified.offsetMinutes;
    utcMs = classified.utcMs;
  } else if (classified.kind === 'overlap') {
    occurrenceUsed = occurrence || 1;
    const chosen = occurrenceUsed === 2 ? classified.second : classified.first;
    sourceOffset = chosen.offsetMinutes;
    utcMs = chosen.utcMs;
  }

  const results = utcMs === null ? [] : data.zones.map((zone) => {
    const zoneOffset = offsetAt(zone, utcMs);
    const rowLocalMs = utcMs + zoneOffset * 60000;
    const local = new Date(rowLocalMs);
    const dayOffset = Math.floor(rowLocalMs / DAY_MS) - baseDay;
    const diffMinutes = zoneOffset - sourceOffset;
    return {
      zoneId: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      offsetMinutes: zoneOffset,
      offsetText: offsetText(zoneOffset),
      localDate: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
      localTime: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
      weekday: WEEKDAY_NAMES[local.getUTCDay()],
      dayOffset,
      dayOffsetText: dayOffsetText(dayOffset),
      diffMinutes,
      diffText: diffText(diffMinutes),
      usesDst: zone.usesDst,
      dstActive: zone.usesDst && zone.dstOffsetMinutes !== null && zoneOffset === zone.dstOffsetMinutes,
      isSource: zone.id === source.id,
    };
  });

  results.sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.name < b.name ? -1 : 1;
  });

  return {
    input: {
      date: date.text,
      time: time.text,
      zoneId: source.id,
      zoneName: source.name,
      zoneDisplayName: source.displayName,
      offsetMinutes: sourceOffset,
      offsetText: sourceOffset === null ? '' : offsetText(sourceOffset),
      dstActive: source.usesDst && sourceOffset !== null && sourceOffset === source.dstOffsetMinutes,
      occurrence: occurrenceUsed,
      usesDst: source.usesDst,
    },
    boundary,
    standard: utcMs === null ? null : wallParts(utcMs),
    zonesInScope: data.zones.length,
    crossDayCount: results.filter((item) => item.dayOffset !== 0).length,
    maxDiffMinutes: results.reduce((acc, item) => Math.max(acc, Math.abs(item.diffMinutes)), 0),
    results,
    convertedAt: new Date().toISOString(),
  };
}

module.exports = { convert, validateDate, validateTime, validateOccurrence, diffText, dayOffsetText };
