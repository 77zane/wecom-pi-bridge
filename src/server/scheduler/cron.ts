const MINUTE = 60_000;

interface CronFieldSpec {
  readonly min: number;
  readonly max: number;
}

const FIELD_SPECS: CronFieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 }
];

export function nextCronDate(expression: string, after: Date, timeZone?: string | undefined): Date | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return null;
  }

  const parsed = fields.map((field, index) => parseCronField(field, FIELD_SPECS[index]!));
  if (parsed.some((field) => field === undefined)) {
    return null;
  }

  const [minutes, hours, days, months, weekdays] = parsed as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  const candidate = new Date(Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE);
  const limit = new Date(after.getTime() + 366 * 24 * 60 * MINUTE);

  while (candidate <= limit) {
    const parts = getDateParts(candidate, timeZone);
    if (
      minutes.has(parts.minute) &&
      hours.has(parts.hour) &&
      days.has(parts.day) &&
      months.has(parts.month) &&
      weekdays.has(parts.weekday)
    ) {
      return candidate;
    }

    candidate.setTime(candidate.getTime() + MINUTE);
  }

  return null;
}

function getDateParts(date: Date, timeZone?: string | undefined): {
  readonly minute: number;
  readonly hour: number;
  readonly day: number;
  readonly month: number;
  readonly weekday: number;
} {
  if (timeZone === undefined || timeZone.length === 0) {
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      day: date.getDate(),
      month: date.getMonth() + 1,
      weekday: date.getDay()
    };
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    minute: "numeric",
    hour: "numeric",
    hourCycle: "h23",
    day: "numeric",
    month: "numeric",
    weekday: "short"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: weekdayToNumber(parts.weekday)
  };
}

function weekdayToNumber(value: string | undefined): number {
  switch (value) {
    case "Sun":
      return 0;
    case "Mon":
      return 1;
    case "Tue":
      return 2;
    case "Wed":
      return 3;
    case "Thu":
      return 4;
    case "Fri":
      return 5;
    case "Sat":
      return 6;
    default:
      return -1;
  }
}

function parseCronField(raw: string, spec: CronFieldSpec): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const parsed = parseCronPart(part, spec);
    if (parsed === undefined) {
      return undefined;
    }
    for (const value of parsed) {
      values.add(value);
    }
  }

  return values;
}

function parseCronPart(raw: string, spec: CronFieldSpec): number[] | undefined {
  const [rangeRaw, stepRaw] = raw.split("/");
  if (rangeRaw === undefined || raw.split("/").length > 2) {
    return undefined;
  }

  const step = stepRaw === undefined ? 1 : Number(stepRaw);
  if (!Number.isInteger(step) || step < 1) {
    return undefined;
  }

  let start: number;
  let end: number;
  if (rangeRaw === "*") {
    start = spec.min;
    end = spec.max;
  } else if (rangeRaw.includes("-")) {
    const [startRaw, endRaw] = rangeRaw.split("-");
    start = Number(startRaw);
    end = Number(endRaw);
  } else {
    start = Number(rangeRaw);
    end = Number(rangeRaw);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < spec.min || end > spec.max || start > end) {
    return undefined;
  }

  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(value);
  }
  return values;
}
