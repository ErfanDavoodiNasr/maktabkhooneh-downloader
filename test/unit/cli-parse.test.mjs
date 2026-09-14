import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {parseArgv, parseNumberSpec, parseStrictNonNegativeInt} from '../../lib/cli-parse.mjs';

describe('parseNumberSpec', () => {
    it('parses singles and ranges', () => {
        assert.deepEqual([...parseNumberSpec('1,3,5-7')].sort((a, b) => a - b), [1, 3, 5, 6, 7]);
    });

    it('normalizes reversed ranges 5-2', () => {
        assert.deepEqual([...parseNumberSpec('5-2')].sort((a, b) => a - b), [2, 3, 4, 5]);
    });

    it('returns null for empty/null', () => {
        assert.equal(parseNumberSpec(null), null);
        assert.equal(parseNumberSpec(''), null);
        assert.equal(parseNumberSpec('   '), null);
    });

    it('rejects invalids', () => {
        assert.throws(() => parseNumberSpec('0'), /Invalid/);
        assert.throws(() => parseNumberSpec('-1'), /Invalid/);
        assert.throws(() => parseNumberSpec('a'), /Invalid/);
        assert.throws(() => parseNumberSpec('1-0'), /Invalid/);
        assert.throws(() => parseNumberSpec('1.5'), /Invalid/);
    });
});

describe('parseStrictNonNegativeInt', () => {
    it('accepts zero and positives', () => {
        assert.equal(parseStrictNonNegativeInt('0'), 0);
        assert.equal(parseStrictNonNegativeInt('65536'), 65536);
    });

    it('rejects floats, empty, negatives, non-digits', () => {
        assert.throws(() => parseStrictNonNegativeInt(''), /empty/);
        assert.throws(() => parseStrictNonNegativeInt('1.5', {name: '--sample-bytes'}), /sample-bytes/);
        assert.throws(() => parseStrictNonNegativeInt('-1'), /Invalid/);
        assert.throws(() => parseStrictNonNegativeInt('abc'), /Invalid/);
    });
});

describe('parseArgv', () => {
    it('parses course, chapter, lesson, dry-run, verbose', () => {
        const r = parseArgv([
            'https://maktabkhooneh.org/course/foo-mk1/',
            '--chapter', '1-2',
            '--lesson', '3',
            '--dry-run',
            '-v'
        ]);
        assert.equal(r.inputCourseRef, 'https://maktabkhooneh.org/course/foo-mk1/');
        assert.ok(r.selectedChapters.has(1) && r.selectedChapters.has(2));
        assert.ok(r.selectedLessons.has(3));
        assert.equal(r.isDryRun, true);
        assert.equal(r.isVerboseLoggingEnabled, true);
        assert.equal(r.jobs, 1);
        assert.equal(r.outputDir, null);
        assert.equal(r.schedule, null);
    });

    it('parses --sample-bytes strictly', () => {
        assert.equal(parseArgv(['--sample-bytes', '100']).sampleBytesToDownload, 100);
        assert.equal(parseArgv(['--sample-bytes=0']).sampleBytesToDownload, 0);
        assert.throws(() => parseArgv(['--sample-bytes', '1.5']), /sample-bytes/);
        assert.throws(() => parseArgv(['--sample-bytes']), /Missing value/);
    });

    it('parses -j/--jobs and rejects invalid', () => {
        assert.equal(parseArgv(['-j', '4']).jobs, 4);
        assert.equal(parseArgv(['--jobs=2']).jobs, 2);
        assert.equal(parseArgv(['-j4']).jobs, 4);
        assert.throws(() => parseArgv(['-j', '0']), /must be > 0/);
        assert.throws(() => parseArgv(['--jobs=-1']), /Invalid/);
        assert.throws(() => parseArgv(['-j', 'abc']), /Invalid/);
        assert.throws(() => parseArgv(['-j']), /Missing value/);
        assert.throws(() => parseArgv(['-j', '999']), /max/);
        assert.throws(() => parseArgv(['-j', '-1']), /Missing value/);
    });

    it('parses -o/--output-dir', () => {
        assert.equal(parseArgv(['-o', './downloads']).outputDir, './downloads');
        assert.equal(parseArgv(['--output-dir=/tmp/out']).outputDir, '/tmp/out');
        assert.throws(() => parseArgv(['-o']), /Missing value/);
    });

    it('parses schedule flags', () => {
        const r = parseArgv([
            '--start-time', '02:00',
            '--stop-time', '07:00',
            '--timezone', 'Asia/Tehran',
            '--no-wait'
        ]);
        assert.equal(r.schedule.mode, 'daily');
        assert.equal(r.noWait, true);
        assert.throws(() => parseArgv(['--start-at', '2026-01-01T00:00:00Z']), /both/);
        assert.throws(() => parseArgv([
            '--start-at', '2026-01-01T00:00:00Z',
            '--stop-at', '2026-01-01T01:00:00Z',
            '--start-time', '02:00'
        ]), /mix/);
    });

    it('rejects unknown options', () => {
        assert.throws(() => parseArgv(['--nope']), /Unknown option/);
    });

    it('sets help for --help / -h', () => {
        assert.equal(parseArgv(['--help']).help, true);
        assert.equal(parseArgv(['-h']).help, true);
    });

    it('parses --config forms', () => {
        assert.equal(parseArgv(['--config', 'a.json']).configPath, 'a.json');
        assert.equal(parseArgv(['--config=b.json']).configPath, 'b.json');
    });
});
