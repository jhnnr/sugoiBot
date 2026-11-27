const limiterRegistry = new Set();

function defaultKeyGenerator(req) {
    const forwarded = req?.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
        const firstIp = forwarded.split(',')[0].trim();
        if (firstIp) {
            return firstIp;
        }
    }
    return req?.ip || req?.socket?.remoteAddress || 'unknown';
}

function setHeaderSafe(res, name, value) {
    if (typeof res?.setHeader === 'function') {
        res.setHeader(name, String(value));
    } else if (typeof res?.set === 'function') {
        res.set(name, String(value));
    }
}

export function createRateLimiter({
    windowMs = 60_000,
    max = 100,
    keyGenerator = defaultKeyGenerator,
    message = 'Too many requests, please try again later.',
    skip
} = {}) {
    const effectiveWindowMs = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0
        ? Number(windowMs)
        : 60_000;
    const effectiveMax = Number.isFinite(Number(max)) && Number(max) > 0
        ? Math.floor(Number(max))
        : 100;

    const store = new Map();
    let nextPruneAt = 0;

    function pruneExpired(now) {
        if (now < nextPruneAt && store.size < 1024) {
            return;
        }
        for (const [key, entry] of store.entries()) {
            if (now >= entry.resetAt) {
                store.delete(key);
            }
        }
        nextPruneAt = now + effectiveWindowMs;
    }

    function rateLimiterMiddleware(req, res, next) {
        if (typeof skip === 'function' && skip(req, res)) {
            return next();
        }

        const now = Date.now();
        pruneExpired(now);

        const rawKey = typeof keyGenerator === 'function'
            ? keyGenerator(req)
            : defaultKeyGenerator(req);
        const key = rawKey ? String(rawKey) : 'unknown';

        let entry = store.get(key);
        if (!entry || now >= entry.resetAt) {
            entry = {
                count: 0,
                resetAt: now + effectiveWindowMs
            };
            store.set(key, entry);
        }

        entry.count += 1;

        const remaining = Math.max(0, effectiveMax - entry.count);
        const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));

        setHeaderSafe(res, 'RateLimit-Limit', effectiveMax);
        setHeaderSafe(res, 'RateLimit-Remaining', remaining);
        setHeaderSafe(res, 'RateLimit-Reset', resetSeconds);

        if (entry.count > effectiveMax) {
            const retryAfter = resetSeconds;
            setHeaderSafe(res, 'Retry-After', retryAfter);
            return res.status(429).json({
                error: message,
                retryAfter
            });
        }

        return next();
    }

    rateLimiterMiddleware.reset = (key) => {
        if (key !== undefined) {
            store.delete(String(key));
        } else {
            store.clear();
            nextPruneAt = 0;
        }
    };

    limiterRegistry.add(rateLimiterMiddleware);
    return rateLimiterMiddleware;
}

export function resetAllRateLimiters() {
    for (const limiter of limiterRegistry) {
        limiter.reset();
    }
}

export const authRateLimiter = createRateLimiter({
    windowMs: Number(process.env.RATE_LIMIT_AUTH_WINDOW_MS) || 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_AUTH_MAX) || 30,
    message: 'Too many authentication attempts, please try again later.'
});

export const apiRateLimiter = createRateLimiter({
    windowMs: Number(process.env.RATE_LIMIT_API_WINDOW_MS) || 60 * 1000,
    max: Number(process.env.RATE_LIMIT_API_MAX) || 300,
    message: 'Too many API requests, please slow down.'
});
