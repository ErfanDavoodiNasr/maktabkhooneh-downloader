/**
 * Single-flight session recovery with generation fencing and cooldown.
 */
import {classifyAuthFailure} from './auth-classify.mjs';
import {ScheduleStoppedError} from './schedule.mjs';

export class AuthenticationError extends Error {
    constructor(message, {code = 'AUTH', permanent = false, cause = null} = {}) {
        super(message, cause ? {cause} : undefined);
        this.name = 'AuthenticationError';
        this.code = code;
        this.permanent = permanent;
    }
}

/**
 * @typedef {object} SessionManagerDeps
 * @property {() => string|null} getCookie
 * @property {(cookie:string) => void} setCookie
 * @property {() => Promise<string>} loginFn  returns new cookie header
 * @property {(cookie:string) => Promise<boolean>} validateFn
 * @property {(cookie:string, generation:number) => Promise<void>} [persistFn]
 * @property {{assertAllowed?:()=>void}} [scheduleGate]
 * @property {() => number} [nowFn]
 * @property {(ms:number)=>Promise<void>} [sleepFn]
 * @property {number} [cooldownMs]
 * @property {number} [maxFailures]
 * @property {(msg:string, meta?:object)=>void} [onInfo]
 * @property {(msg:string, meta?:object)=>void} [onWarn]
 * @property {object} [metrics]
 */

export function createSessionManager(deps) {
    const {
        getCookie,
        setCookie,
        loginFn,
        validateFn,
        persistFn = null,
        scheduleGate = null,
        nowFn = () => Date.now(),
        sleepFn = async () => {
        },
        cooldownMs = 5_000,
        maxFailures = 3,
        onInfo = () => {
        },
        onWarn = () => {
        },
        metrics = null
    } = deps;

    let generation = 0;
    let inFlight = null;
    let consecutiveFailures = 0;
    let cooldownUntil = 0;
    let permanentlyFailed = false;
    let lastError = null;

    const bump = (key) => {
        if (metrics && typeof metrics === 'object') {
            metrics[key] = (metrics[key] || 0) + 1;
        }
    };

    function getGeneration() {
        return generation;
    }

    function isPermanentlyFailed() {
        return permanentlyFailed;
    }

    /**
     * Recover from expired/invalid session. Single-flight across workers.
     * @param {{reason?:string, seenGeneration?:number}} [opts]
     */
    async function recover(opts = {}) {
        const {reason = 'auth failure', seenGeneration = null} = opts;

        if (permanentlyFailed) {
            throw new AuthenticationError(
                `Authentication permanently failed; not retrying login (${lastError?.message || 'unknown'})`,
                {code: 'AUTH_PERMANENT', permanent: true, cause: lastError}
            );
        }

        try {
            scheduleGate?.assertAllowed?.();
        } catch (e) {
            if (e instanceof ScheduleStoppedError || e?.code === 'SCHEDULE_STOP') throw e;
            throw e;
        }

        // Another worker already refreshed past the generation we saw — reuse
        if (seenGeneration != null && generation > seenGeneration) {
            bump('authReuse');
            onInfo('Reusing session refreshed by another worker', {generation});
            return {cookie: getCookie(), generation, reused: true};
        }

        if (inFlight) {
            bump('authWait');
            return inFlight;
        }

        inFlight = (async () => {
            bump('authRecoverAttempts');
            const startGen = generation;
            try {
                const now = nowFn();
                if (now < cooldownUntil) {
                    const wait = cooldownUntil - now;
                    onWarn(`Auth cooldown ${wait}ms before re-login (${reason})`);
                    await sleepFn(wait);
                    scheduleGate?.assertAllowed?.();
                }

                onInfo(`Re-authenticating (${reason})…`);
                const cookie = await loginFn();
                if (!cookie || cookie === 'PUT_YOUR_COOKIE_HERE') {
                    throw new AuthenticationError('Login returned empty session cookie', {
                        code: 'AUTH_EMPTY',
                        permanent: true
                    });
                }

                const ok = await validateFn(cookie);
                if (!ok) {
                    throw new AuthenticationError('Login succeeded but session validation failed', {
                        code: 'AUTH_VALIDATE',
                        permanent: false
                    });
                }

                // Generation fence: only advance if we still own this recovery
                if (generation !== startGen) {
                    bump('authReuse');
                    return {cookie: getCookie(), generation, reused: true};
                }

                setCookie(cookie);
                generation += 1;
                consecutiveFailures = 0;
                lastError = null;

                if (typeof persistFn === 'function') {
                    try {
                        await persistFn(cookie, generation);
                        bump('authPersistOk');
                    } catch (pe) {
                        // Session is valid in-memory; warn but do not fail the download
                        onWarn(`Could not persist refreshed session: ${pe.message}`);
                        bump('authPersistFail');
                    }
                }

                bump('authRecoverOk');
                onInfo('Session refreshed successfully', {generation});
                return {cookie, generation, reused: false};
            } catch (err) {
                if (err instanceof ScheduleStoppedError || err?.code === 'SCHEDULE_STOP') throw err;
                consecutiveFailures += 1;
                lastError = err instanceof Error ? err : new Error(String(err));
                cooldownUntil = nowFn() + cooldownMs * consecutiveFailures;
                bump('authRecoverFail');
                if (consecutiveFailures >= maxFailures) {
                    permanentlyFailed = true;
                    throw new AuthenticationError(
                        `Authentication failed ${consecutiveFailures} times: ${lastError.message}`,
                        {code: 'AUTH_PERMANENT', permanent: true, cause: lastError}
                    );
                }
                throw new AuthenticationError(lastError.message, {
                    code: 'AUTH_RETRY',
                    permanent: false,
                    cause: lastError
                });
            } finally {
                inFlight = null;
            }
        })();

        return inFlight;
    }

    return {
        classify: classifyAuthFailure,
        recover,
        getGeneration,
        getCookie,
        isPermanentlyFailed,
        /** @internal test helpers */
        _state: () => ({generation, consecutiveFailures, permanentlyFailed, cooldownUntil, inFlight: !!inFlight})
    };
}
