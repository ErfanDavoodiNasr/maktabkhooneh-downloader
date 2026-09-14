/**
 * One-time and recurring daily download windows.
 * Stop boundary is exclusive. Clock injectable for tests.
 */
import {setTimeout as defaultSleep} from 'timers/promises';

export class ScheduleError extends Error {
    constructor(message, code = 'SCHEDULE') {
        super(message);
        this.name = 'ScheduleError';
        this.code = code;
    }
}

export class ScheduleStoppedError extends Error {
    constructor(message = 'Download stopped: outside permitted time window') {
        super(message);
        this.name = 'ScheduleStoppedError';
        this.code = 'SCHEDULE_STOP';
        this.deferred = true;
    }
}

const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parse HH:MM[:SS] into {h,m,s}.
 */
export function parseClockTime(raw, {name = 'time'} = {}) {
    if (raw == null || String(raw).trim() === '') {
        throw new ScheduleError(`Invalid ${name}: empty`, 'SCHEDULE_TIME');
    }
    const s = String(raw).trim();
    const m = s.match(TIME_RE);
    if (!m) throw new ScheduleError(`Invalid ${name}: ${raw} (expected HH:MM[:SS])`, 'SCHEDULE_TIME');
    const h = Number.parseInt(m[1], 10);
    const min = Number.parseInt(m[2], 10);
    const sec = m[3] != null ? Number.parseInt(m[3], 10) : 0;
    if (h > 23 || min > 59 || sec > 59) {
        throw new ScheduleError(`Invalid ${name}: ${raw} (out of range)`, 'SCHEDULE_TIME');
    }
    return {h, m: min, s: sec};
}

/**
 * Parse ISO-8601 datetime; require timezone offset or Z (reject naive local).
 */
export function parseIsoDateTime(raw, {name = 'datetime'} = {}) {
    if (raw == null || String(raw).trim() === '') {
        throw new ScheduleError(`Invalid ${name}: empty`, 'SCHEDULE_DATETIME');
    }
    const s = String(raw).trim();
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
        throw new ScheduleError(
            `Invalid ${name}: ${raw} (timezone required; use Z or ±HH:MM)`,
            'SCHEDULE_DATETIME'
        );
    }
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) {
        throw new ScheduleError(`Invalid ${name}: ${raw}`, 'SCHEDULE_DATETIME');
    }
    return new Date(ms);
}

export function resolveTimezone(tz) {
    const name = String(tz || '').trim();
    if (!name) throw new ScheduleError('Invalid timezone: empty', 'SCHEDULE_TZ');
    try {
        // Throws RangeError for unknown IANA zones
        new Intl.DateTimeFormat('en-US', {timeZone: name}).format(new Date());
        return name;
    } catch {
        throw new ScheduleError(`Invalid timezone: ${tz}`, 'SCHEDULE_TZ');
    }
}

function secondsOfDay(h, m, s) {
    return h * 3600 + m * 60 + s;
}

function zonedParts(date, timeZone) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second)
    };
}

function zonedSecondsOfDay(date, timeZone) {
    const p = zonedParts(date, timeZone);
    return secondsOfDay(p.hour, p.minute, p.second);
}

/**
 * Approximate instant for a civil date+time in a timezone (handles DST via iteration).
 */
function zonedLocalToUtc(year, month, day, h, m, s, timeZone) {
    // Start from a UTC guess and refine
    let guess = Date.UTC(year, month - 1, day, h, m, s);
    for (let i = 0; i < 4; i++) {
        const p = zonedParts(new Date(guess), timeZone);
        const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
        const want = Date.UTC(year, month - 1, day, h, m, s);
        const delta = want - asUtc;
        if (delta === 0) break;
        guess += delta;
    }
    return new Date(guess);
}

function addCalendarDays(year, month, day, deltaDays) {
    const d = new Date(Date.UTC(year, month - 1, day + deltaDays));
    return {year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate()};
}

/**
 * Validate and normalize schedule options from CLI.
 * @returns {null|{mode:'once'|'daily', ...}}
 */
export function buildSchedule({
                                  startAt = null,
                                  stopAt = null,
                                  startTime = null,
                                  stopTime = null,
                                  timezone = null,
                                  noWait = false
                              } = {}) {
    const hasOnce = startAt != null || stopAt != null;
    const hasDaily = startTime != null || stopTime != null || timezone != null;

    if (!hasOnce && !hasDaily) {
        return null;
    }
    if (hasOnce && (startTime != null || stopTime != null)) {
        throw new ScheduleError(
            'Cannot mix --start-at/--stop-at with --start-time/--stop-time',
            'SCHEDULE_CONFLICT'
        );
    }
    if (hasOnce) {
        if (startAt == null || stopAt == null) {
            throw new ScheduleError(
                'One-time schedule requires both --start-at and --stop-at',
                'SCHEDULE_PAIR'
            );
        }
        if (timezone != null) {
            throw new ScheduleError(
                '--timezone applies to daily windows; one-time mode uses offsets in --start-at/--stop-at',
                'SCHEDULE_CONFLICT'
            );
        }
        const start = parseIsoDateTime(startAt, {name: '--start-at'});
        const stop = parseIsoDateTime(stopAt, {name: '--stop-at'});
        if (stop.getTime() <= start.getTime()) {
            throw new ScheduleError(
                '--stop-at must be after --start-at (stop is exclusive; equal times yield an empty window)',
                'SCHEDULE_EMPTY'
            );
        }
        return {mode: 'once', start, stop, noWait: !!noWait};
    }

    if (startTime == null || stopTime == null) {
        throw new ScheduleError(
            'Daily schedule requires both --start-time and --stop-time',
            'SCHEDULE_PAIR'
        );
    }
    const tz = resolveTimezone(timezone || 'UTC');
    const start = parseClockTime(startTime, {name: '--start-time'});
    const stop = parseClockTime(stopTime, {name: '--stop-time'});
    if (secondsOfDay(start.h, start.m, start.s) === secondsOfDay(stop.h, stop.m, stop.s)) {
        throw new ScheduleError(
            '--start-time and --stop-time must differ (empty daily window)',
            'SCHEDULE_EMPTY'
        );
    }
    return {mode: 'daily', start, stop, timezone: tz, noWait: !!noWait};
}

function dailyWindowAround(now, schedule) {
    const tz = schedule.timezone;
    const p = zonedParts(now, tz);
    const startSec = secondsOfDay(schedule.start.h, schedule.start.m, schedule.start.s);
    const stopSec = secondsOfDay(schedule.stop.h, schedule.stop.m, schedule.stop.s);
    const crossesMidnight = startSec > stopSec;

    const todayStart = zonedLocalToUtc(p.year, p.month, p.day, schedule.start.h, schedule.start.m, schedule.start.s, tz);
    let todayStop;
    if (crossesMidnight) {
        const next = addCalendarDays(p.year, p.month, p.day, 1);
        todayStop = zonedLocalToUtc(next.year, next.month, next.day, schedule.stop.h, schedule.stop.m, schedule.stop.s, tz);
    } else {
        todayStop = zonedLocalToUtc(p.year, p.month, p.day, schedule.stop.h, schedule.stop.m, schedule.stop.s, tz);
    }

    const curSec = zonedSecondsOfDay(now, tz);
    let inWindow;
    if (crossesMidnight) {
        inWindow = curSec >= startSec || curSec < stopSec;
    } else {
        inWindow = curSec >= startSec && curSec < stopSec;
    }

    // Next open / next close relative to now
    let nextOpen = todayStart;
    let nextClose = todayStop;
    if (crossesMidnight) {
        if (curSec >= stopSec && curSec < startSec) {
            // Between morning stop and evening start — wait for today's start
            nextOpen = todayStart;
            nextClose = todayStop;
            inWindow = false;
        } else if (curSec >= startSec) {
            // After evening start → in window until tomorrow stop
            inWindow = true;
            nextOpen = todayStart;
            nextClose = todayStop;
        } else {
            // After midnight, before stop → still in yesterday's window
            inWindow = true;
            const prev = addCalendarDays(p.year, p.month, p.day, -1);
            nextOpen = zonedLocalToUtc(prev.year, prev.month, prev.day, schedule.start.h, schedule.start.m, schedule.start.s, tz);
            nextClose = zonedLocalToUtc(p.year, p.month, p.day, schedule.stop.h, schedule.stop.m, schedule.stop.s, tz);
        }
    } else if (!inWindow) {
        if (now < todayStart) {
            nextOpen = todayStart;
            nextClose = todayStop;
        } else {
            const next = addCalendarDays(p.year, p.month, p.day, 1);
            nextOpen = zonedLocalToUtc(next.year, next.month, next.day, schedule.start.h, schedule.start.m, schedule.start.s, tz);
            nextClose = zonedLocalToUtc(next.year, next.month, next.day, schedule.stop.h, schedule.stop.m, schedule.stop.s, tz);
        }
    }

    return {inWindow, nextOpen, nextClose};
}

/**
 * @returns {{allowed:boolean, state:string, nextOpen?:Date, nextClose?:Date, message:string}}
 */
export function evaluateSchedule(schedule, now = new Date()) {
    if (!schedule) {
        return {allowed: true, state: 'none', message: 'No schedule restrictions'};
    }
    const t = now instanceof Date ? now : new Date(now);

    if (schedule.mode === 'once') {
        if (t.getTime() < schedule.start.getTime()) {
            return {
                allowed: false,
                state: 'waiting_start',
                nextOpen: schedule.start,
                nextClose: schedule.stop,
                message: `Waiting for start window at ${schedule.start.toISOString()}`
            };
        }
        if (t.getTime() >= schedule.stop.getTime()) {
            return {
                allowed: false,
                state: 'finished',
                nextOpen: null,
                nextClose: schedule.stop,
                message: `One-time window ended at ${schedule.stop.toISOString()} (stop exclusive)`
            };
        }
        return {
            allowed: true,
            state: 'active',
            nextOpen: schedule.start,
            nextClose: schedule.stop,
            message: `Inside one-time window until ${schedule.stop.toISOString()}`
        };
    }

    const w = dailyWindowAround(t, schedule);
    if (w.inWindow) {
        return {
            allowed: true,
            state: 'active',
            nextOpen: w.nextOpen,
            nextClose: w.nextClose,
            message: `Inside daily window until ${w.nextClose.toISOString()} (${schedule.timezone})`
        };
    }
    return {
        allowed: false,
        state: 'waiting_daily',
        nextOpen: w.nextOpen,
        nextClose: w.nextClose,
        message: `Outside daily window; next opens at ${w.nextOpen.toISOString()} (${schedule.timezone})`
    };
}

/**
 * Wait until schedule allows work. Uses wall clock for decisions; sleep injectable.
 * Throws ScheduleError when --no-wait and outside window, or when one-time window is over.
 */
export async function waitUntilAllowed(schedule, {
    nowFn = () => new Date(),
    sleepFn = defaultSleep,
    signal = null,
    onStatus = () => {
    },
    maxSleepMs = 60_000
} = {}) {
    if (!schedule) return evaluateSchedule(null);

    while (true) {
        if (signal?.aborted) {
            const err = new Error('Interrupted while waiting for schedule window');
            err.code = 'INTERRUPTED';
            throw err;
        }
        const status = evaluateSchedule(schedule, nowFn());
        if (status.allowed) {
            onStatus({...status, phase: 'active'});
            return status;
        }
        if (status.state === 'finished') {
            throw new ScheduleError(status.message, 'SCHEDULE_FINISHED');
        }
        if (schedule.noWait) {
            throw new ScheduleError(
                `[NO_WAIT] ${status.message}`,
                'SCHEDULE_NO_WAIT'
            );
        }
        onStatus({...status, phase: status.state === 'waiting_start' ? 'waiting_start' : 'waiting_daily'});
        const next = status.nextOpen;
        if (!next) {
            throw new ScheduleError(status.message, 'SCHEDULE_BLOCKED');
        }
        const delay = Math.max(0, next.getTime() - nowFn().getTime());
        // Sleep in chunks so cancellation / clock injection stay responsive
        const slice = Math.min(delay || 0, maxSleepMs);
        if (slice <= 0) {
            // Clock jumped / nextOpen in the past — re-evaluate after a tiny yield
            await sleepFn(1);
            continue;
        }
        if (signal) {
            await Promise.race([
                sleepFn(slice),
                new Promise((_, reject) => {
                    const onAbort = () => {
                        const err = new Error('Interrupted while waiting for schedule window');
                        err.code = 'INTERRUPTED';
                        reject(err);
                    };
                    if (signal.aborted) onAbort();
                    else signal.addEventListener('abort', onAbort, {once: true});
                })
            ]);
        } else {
            await sleepFn(slice);
        }
    }
}

/**
 * Gate used before HTTP / retries and cooperatively during streaming.
 */
export function createScheduleGate(schedule, {
    nowFn = () => new Date(),
    onStatus = () => {
    }
} = {}) {
    if (!schedule) {
        return {
            assertAllowed() {
            },
            shouldContinue() {
                return true;
            },
            peek() {
                return evaluateSchedule(null);
            }
        };
    }
    return {
        assertAllowed() {
            const st = evaluateSchedule(schedule, nowFn());
            if (!st.allowed) {
                onStatus({...st, phase: 'stopping'});
                throw new ScheduleStoppedError(st.message);
            }
        },
        shouldContinue() {
            const st = evaluateSchedule(schedule, nowFn());
            if (!st.allowed) {
                onStatus({...st, phase: 'stopping'});
                return false;
            }
            return true;
        },
        peek() {
            return evaluateSchedule(schedule, nowFn());
        }
    };
}
