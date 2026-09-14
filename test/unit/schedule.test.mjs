import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSchedule,
    createScheduleGate,
    evaluateSchedule,
    parseClockTime,
    parseIsoDateTime,
    resolveTimezone,
    ScheduleError,
    waitUntilAllowed
} from '../../lib/schedule.mjs';

describe('parseClockTime / parseIsoDateTime', () => {
    it('parses HH:MM and HH:MM:SS', () => {
        assert.deepEqual(parseClockTime('2:00'), {h: 2, m: 0, s: 0});
        assert.deepEqual(parseClockTime('23:59:59'), {h: 23, m: 59, s: 59});
    });
    it('rejects bad times', () => {
        assert.throws(() => parseClockTime(''), /empty/);
        assert.throws(() => parseClockTime('25:00'), /out of range/);
        assert.throws(() => parseClockTime('ab:cd'), /expected/);
    });
    it('requires timezone on ISO datetimes', () => {
        assert.throws(() => parseIsoDateTime('2026-09-15T02:00:00'), /timezone required/);
        const d = parseIsoDateTime('2026-09-15T02:00:00+03:30');
        assert.ok(d instanceof Date);
    });
    it('rejects invalid timezone', () => {
        assert.throws(() => resolveTimezone('Not/AZone'), /Invalid timezone/);
        assert.equal(resolveTimezone('Asia/Tehran'), 'Asia/Tehran');
    });
});

describe('buildSchedule', () => {
    it('returns null when unset', () => {
        assert.equal(buildSchedule({}), null);
    });
    it('rejects mixing modes', () => {
        assert.throws(() => buildSchedule({
            startAt: '2026-09-15T02:00:00Z',
            stopAt: '2026-09-15T07:00:00Z',
            startTime: '02:00'
        }), ScheduleError);
    });
    it('requires pairs', () => {
        assert.throws(() => buildSchedule({startAt: '2026-09-15T02:00:00Z'}), /both/);
        assert.throws(() => buildSchedule({startTime: '02:00'}), /both/);
    });
    it('rejects empty once window', () => {
        assert.throws(() => buildSchedule({
            startAt: '2026-09-15T02:00:00Z',
            stopAt: '2026-09-15T02:00:00Z'
        }), /empty|after/);
    });
    it('builds daily schedule', () => {
        const s = buildSchedule({
            startTime: '02:00',
            stopTime: '07:00',
            timezone: 'Asia/Tehran'
        });
        assert.equal(s.mode, 'daily');
        assert.equal(s.timezone, 'Asia/Tehran');
    });
});

describe('evaluateSchedule one-time', () => {
    const schedule = buildSchedule({
        startAt: '2026-09-15T02:00:00+03:30',
        stopAt: '2026-09-15T07:00:00+03:30'
    });
    it('before start', () => {
        const st = evaluateSchedule(schedule, new Date('2026-09-15T01:00:00+03:30'));
        assert.equal(st.allowed, false);
        assert.equal(st.state, 'waiting_start');
    });
    it('exactly at start inclusive', () => {
        const st = evaluateSchedule(schedule, new Date('2026-09-15T02:00:00+03:30'));
        assert.equal(st.allowed, true);
        assert.equal(st.state, 'active');
    });
    it('exactly at stop exclusive', () => {
        const st = evaluateSchedule(schedule, new Date('2026-09-15T07:00:00+03:30'));
        assert.equal(st.allowed, false);
        assert.equal(st.state, 'finished');
    });
    it('inside window', () => {
        const st = evaluateSchedule(schedule, new Date('2026-09-15T05:00:00+03:30'));
        assert.equal(st.allowed, true);
    });
});

describe('evaluateSchedule daily', () => {
    const schedule = buildSchedule({
        startTime: '02:00',
        stopTime: '07:00',
        timezone: 'UTC'
    });
    it('inside daily window', () => {
        const st = evaluateSchedule(schedule, new Date('2026-06-01T03:00:00Z'));
        assert.equal(st.allowed, true);
    });
    it('before daily opening', () => {
        const st = evaluateSchedule(schedule, new Date('2026-06-01T01:00:00Z'));
        assert.equal(st.allowed, false);
        assert.equal(st.state, 'waiting_daily');
    });
    it('at stop exclusive', () => {
        const st = evaluateSchedule(schedule, new Date('2026-06-01T07:00:00Z'));
        assert.equal(st.allowed, false);
    });
    it('midnight-crossing window', () => {
        const night = buildSchedule({
            startTime: '23:00',
            stopTime: '02:00',
            timezone: 'UTC'
        });
        assert.equal(evaluateSchedule(night, new Date('2026-06-01T23:30:00Z')).allowed, true);
        assert.equal(evaluateSchedule(night, new Date('2026-06-02T01:00:00Z')).allowed, true);
        assert.equal(evaluateSchedule(night, new Date('2026-06-02T02:00:00Z')).allowed, false);
        assert.equal(evaluateSchedule(night, new Date('2026-06-01T12:00:00Z')).allowed, false);
    });
});

describe('waitUntilAllowed / gate', () => {
    it('--no-wait exits when outside', async () => {
        const schedule = buildSchedule({
            startAt: '2099-01-01T00:00:00Z',
            stopAt: '2099-01-01T01:00:00Z',
            noWait: true
        });
        await assert.rejects(() => waitUntilAllowed(schedule, {
            nowFn: () => new Date('2026-01-01T00:00:00Z'),
            sleepFn: async () => {
            }
        }), /NO_WAIT|Waiting/);
    });
    it('waits with fake clock then allows', async () => {
        let now = new Date('2026-09-15T01:00:00Z').getTime();
        const schedule = buildSchedule({
            startAt: '2026-09-15T02:00:00Z',
            stopAt: '2026-09-15T07:00:00Z'
        });
        const phases = [];
        await waitUntilAllowed(schedule, {
            nowFn: () => new Date(now),
            sleepFn: async (ms) => {
                now += ms;
            },
            onStatus: (s) => phases.push(s.phase),
            maxSleepMs: 3_600_000
        });
        assert.ok(phases.includes('waiting_start'));
        assert.ok(phases.includes('active'));
    });
    it('gate blocks after stop', () => {
        const schedule = buildSchedule({
            startAt: '2026-09-15T02:00:00Z',
            stopAt: '2026-09-15T07:00:00Z'
        });
        let t = new Date('2026-09-15T06:59:00Z');
        const gate = createScheduleGate(schedule, {nowFn: () => t});
        gate.assertAllowed();
        t = new Date('2026-09-15T07:00:00Z');
        assert.equal(gate.shouldContinue(), false);
        assert.throws(() => gate.assertAllowed(), /window/);
    });
});
