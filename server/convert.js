const { load, WEEKDAY_NAMES } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');
const { classifyLocalTime } = require('./dst');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86400000;
const OCCURRENCE_TEXT = { first: '第一次出现', second: '第二次出现' };

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

// 挂钟读数（UTC 刻度）格式化成 年-月-日 时:分，用来描述跳过段与重复段的区间
function wallText(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

// 一段分钟数写成“1 小时 30 分”，用来描述时钟拨了多少
function minutesText(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const parts = [];
  if (hour) parts.push(`${hour} 小时`);
  if (minute) parts.push(`${minute} 分`);
  return parts.join(' ') || '0 分';
}

// 换算：先把输入时刻按来源时区的偏移折算成基准时刻，再逐个时区加上各自的偏移。
// 来源时区实行夏令时时，先把输入的当地时刻比对当年的切换点：
// 落在向前跳过的那段按不存在的时刻处理，落在向后重复的那段要选定按哪一次出现换算。
function convert(options) {
  const input = options && typeof options === 'object' ? options : {};
  const date = validateDate(input.date);
  const time = validateTime(input.time);
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择来源时区', 'zoneId');
  const occurrence = pickText(input.occurrence);
  if (occurrence && occurrence !== 'first' && occurrence !== 'second') {
    throw new ApiError(400, 'OCCURRENCE_INVALID', '出现次序只能填 first（第一次出现）或 second（第二次出现）', 'occurrence');
  }

  const data = load();
  const source = data.zones.find((item) => item.id === zoneId);
  if (!source) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过', 'zoneId');

  const baseMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const boundary = classifyLocalTime(source, date.year, baseMs);

  if (boundary.kind === 'gap') {
    throw new ApiError(
      400,
      'TIME_NOT_EXIST',
      `这个时刻在 ${source.name} 不存在：${wallText(boundary.startMs)} 至 ${wallText(boundary.endMs)} 这段在切换当天被跳过（时钟向前拨了 ${minutesText(boundary.gapMinutes)}），请改填其他时刻`,
      'time',
    );
  }

  // 重复段里同一串数字出现两次：第一次还在夏令时，第二次已经回到标准时间，两次对应不同的瞬间
  let effectiveOffset = source.offsetMinutes;
  let repeated = null;
  if (boundary.kind === 'repeat') {
    if (!occurrence) {
      throw new ApiError(
        400,
        'TIME_REPEATED',
        `这个时刻落在 ${source.name} 切换当天的重复段（${wallText(boundary.startMs)} 至 ${wallText(boundary.endMs)}）里，同一串数字会出现两次：第一次出现按夏令时 ${offsetText(source.dstOffsetMinutes)} 计，第二次出现按标准偏移 ${offsetText(source.offsetMinutes)} 计，两次对应不同的瞬间，请选择按哪一次出现换算`,
        'occurrence',
      );
    }
    effectiveOffset = occurrence === 'first' ? source.dstOffsetMinutes : source.offsetMinutes;
    const other = occurrence === 'first' ? 'second' : 'first';
    repeated = {
      occurrence,
      occurrenceText: OCCURRENCE_TEXT[occurrence],
      offsetText: offsetText(effectiveOffset),
      otherOccurrence: other,
      otherOccurrenceText: OCCURRENCE_TEXT[other],
      otherOffsetText: offsetText(other === 'first' ? source.dstOffsetMinutes : source.offsetMinutes),
      rangeText: `${wallText(boundary.startMs)} 至 ${wallText(boundary.endMs)}`,
    };
  }

  const utcMs = baseMs - effectiveOffset * 60000;
  const baseDay = Math.floor(baseMs / DAY_MS);
  const utcDate = new Date(utcMs);

  const results = data.zones.map((zone) => {
    const localMs = utcMs + zone.offsetMinutes * 60000;
    const local = new Date(localMs);
    const dayOffset = Math.floor(localMs / DAY_MS) - baseDay;
    const diffMinutes = zone.offsetMinutes - effectiveOffset;
    return {
      zoneId: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      offsetMinutes: zone.offsetMinutes,
      offsetText: offsetText(zone.offsetMinutes),
      localDate: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
      localTime: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
      weekday: WEEKDAY_NAMES[local.getUTCDay()],
      dayOffset,
      dayOffsetText: dayOffsetText(dayOffset),
      diffMinutes,
      diffText: diffText(diffMinutes),
      usesDst: zone.usesDst,
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
      offsetText: offsetText(source.offsetMinutes),
      usesDst: source.usesDst,
      boundary: repeated,
    },
    standard: {
      date: `${utcDate.getUTCFullYear()}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())}`,
      time: `${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}`,
    },
    zonesInScope: data.zones.length,
    crossDayCount: results.filter((item) => item.dayOffset !== 0).length,
    maxDiffMinutes: results.reduce((acc, item) => Math.max(acc, Math.abs(item.diffMinutes)), 0),
    results,
    convertedAt: new Date().toISOString(),
  };
}

module.exports = { convert, validateDate, validateTime, diffText, dayOffsetText };
