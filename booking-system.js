if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const { createClient } = require('redis');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const REDIS_URL = process.env.REDIS_URL || '';
const TOTAL_SEATS = Number(process.env.TOTAL_SEATS || 100);
const LOCK_KEY = 'ticket:lock';
const LOCK_TTL_MS = 5000;
let redisErrorLogged = false;

if (!REDIS_URL) {
  console.error('Missing REDIS_URL environment variable.');
  console.error('Local example: REDIS_URL=redis://127.0.0.1:6379');
  console.error('Render example: use your managed Redis Internal/External URL.');
  process.exit(1);
}

const redis = createClient({
  url: REDIS_URL,
  socket: {
    reconnectStrategy: () => false,
  },
});

redis.on('error', (err) => {
  if (!redisErrorLogged) {
    console.error(`Redis error: ${err.message}`);
    redisErrorLogged = true;
  }
});

async function acquireLock(lockId) {
  return redis.set(LOCK_KEY, lockId, {
    NX: true,
    PX: LOCK_TTL_MS,
  });
}

async function releaseLock(lockId) {
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
  const exists = await redis.exists('ticket:remaining');
  if (!exists) {
    await redis.set('ticket:remaining', TOTAL_SEATS.toString());
  }
}

app.get('/api/status', async (_req, res) => {
  try {
    const remaining = Number(await redis.get('ticket:remaining'));
    return res.status(200).json({
      service: 'Concurrent Ticket Booking System',
      totalSeats: TOTAL_SEATS,
      remaining,
      sold: TOTAL_SEATS - remaining,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/book', async (_req, res) => {
  const lockId = `lock-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const lockResult = await acquireLock(lockId);

    if (lockResult === 'OK') {
      try {
        const remaining = Number(await redis.get('ticket:remaining'));

        if (remaining <= 0) {
          return res.status(409).json({
            success: false,
            message: 'Sold out',
            remaining: 0,
          });
        }

        const newRemaining = await redis.decr('ticket:remaining');
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
});

app.post('/api/reset', async (_req, res) => {
  try {
    await redis.set('ticket:remaining', TOTAL_SEATS.toString());
    return res.status(200).json({
      success: true,
      message: 'Inventory reset complete',
      remaining: TOTAL_SEATS,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

(async () => {
  try {
    await redis.connect();
    await initInventory();
  } catch (error) {
    console.error('Unable to connect to Redis.');
    console.error(`Configured URL: ${REDIS_URL}`);
    console.error('Start Redis and retry. Example (Docker): docker run --name redis-lab -p 6379:6379 -d redis');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`node booking-system.js`);
    console.log(`Booking system running on port ${PORT}`);
  });
})();
