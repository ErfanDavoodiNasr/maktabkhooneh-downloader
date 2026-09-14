/**
 * Stable CLI exit codes. Keep 0/1/2 behavior compatible with prior releases.
 */
export const EXIT = Object.freeze({
    SUCCESS: 0,
    FAILURE: 1,
    USAGE: 2,
    INTERRUPTED: 130
});
