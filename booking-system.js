if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const { createClient } = require('redis');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3000);
const REDIS_URL = process.env.REDIS_URL || '';
const TOTAL_SEATS = Number(process.env.TOTAL_SEATS || 100);
const LOCK_KEY = 'ticket:lock';
const LOCK_TTL_MS = 5000;
let redisErrorLogged = false;
let usingRedis = Boolean(REDIS_URL);
let memoryRemaining = TOTAL_SEATS;
let memoryLock = {
  owner: null,
  expiresAt: 0,
};

const redis = createClient({
  url: REDIS_URL || 'redis://127.0.0.1:6379',
  socket: {
    reconnectStrategy: () => false,
  },
});

redis.on('error', (err) => {
  if (!redisErrorLogged && usingRedis) {
    console.error(`Redis error: ${err.message}`);
    redisErrorLogged = true;
  }
});

async function acquireLock(lockId) {
  if (!usingRedis) {
    const now = Date.now();
    if (!memoryLock.owner || memoryLock.expiresAt <= now) {
      memoryLock.owner = lockId;
      memoryLock.expiresAt = now + LOCK_TTL_MS;
      return 'OK';
    }
    return null;
  }

  return redis.set(LOCK_KEY, lockId, {
    NX: true,
    PX: LOCK_TTL_MS,
  });
}

async function releaseLock(lockId) {
  if (!usingRedis) {
    if (memoryLock.owner === lockId) {
      memoryLock.owner = null;
      memoryLock.expiresAt = 0;
      return 1;
    }
    return 0;
  }

  const releaseLua = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;

  return redis.eval(releaseLua, {
    keys: [LOCK_KEY],
    arguments: [lockId],
  });
}

async function initInventory() {
  if (!usingRedis) {
    memoryRemaining = TOTAL_SEATS;
    return;
  }

  const exists = await redis.exists('ticket:remaining');
  if (!exists) {
    await redis.set('ticket:remaining', TOTAL_SEATS.toString());
  }
}

async function getRemaining() {
  if (!usingRedis) {
    return memoryRemaining;
  }

  return Number(await redis.get('ticket:remaining'));
}

async function decrementRemaining() {
  if (!usingRedis) {
    memoryRemaining -= 1;
    return memoryRemaining;
  }

  return redis.decr('ticket:remaining');
}

async function resetRemaining() {
  if (!usingRedis) {
    memoryRemaining = TOTAL_SEATS;
    return TOTAL_SEATS;
  }

  await redis.set('ticket:remaining', TOTAL_SEATS.toString());
  return TOTAL_SEATS;
}

app.get('/api/status', async (_req, res) => {
  try {
    const remaining = await getRemaining();
    return res.status(200).json({
      service: 'Concurrent Ticket Booking System',
      storage: usingRedis ? 'redis' : 'memory',
      totalSeats: TOTAL_SEATS,
      remaining,
      sold: TOTAL_SEATS - remaining,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/', (_req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function handleBook(_req, res) {
  const lockId = `lock-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const lockResult = await acquireLock(lockId);

    if (lockResult === 'OK') {
      try {
        const remaining = await getRemaining();

        if (remaining <= 0) {
          return res.status(409).json({
            success: false,
            message: 'Sold out',
            remaining: 0,
          });
        }

        const newRemaining = await decrementRemaining();
        const bookingId = Date.now();

        return res.status(200).json({
          success: true,
          bookingId,
          remaining: newRemaining,
        });
      } finally {
        await releaseLock(lockId);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return res.status(503).json({
    success: false,
    message: 'Could not acquire lock. Please retry.',
  });
}

app.post('/api/book', handleBook);
app.get('/api/book', handleBook);

app.post('/api/reset', async (_req, res) => {
  try {
    const remaining = await resetRemaining();
    return res.status(200).json({
      success: true,
      message: 'Inventory reset complete',
      remaining,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

(async () => {
  if (REDIS_URL) {
    try {
      await redis.connect();
      usingRedis = true;
    } catch (error) {
      usingRedis = false;
      console.warn('Redis unavailable. Falling back to in-memory storage.');
      console.warn(`Configured URL: ${REDIS_URL}`);
    }
  } else {
    usingRedis = false;
    console.warn('REDIS_URL not set. Running with in-memory storage.');
  }

  await initInventory();

  app.listen(PORT, () => {
    console.log(`node booking-system.js`);
    console.log(`Booking system running on port ${PORT}`);
    console.log(`Storage mode: ${usingRedis ? 'redis' : 'memory'}`);
  });
})();
