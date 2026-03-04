# Experiment 4.3 - Concurrent Ticket Booking System

## Aim
Create a concurrent ticket booking system with seat locking using Redis.

## Hardware/Software Requirements
- Node.js 18+
- Redis
- Express.js
- Load testing tool (Artillery)

## Project Files
- `booking-system.js` - Express API with Redis lock-based booking
- `artillery.yml` - Load test configuration for concurrent booking requests
- `package.json` - Scripts and dependencies

## Setup
1. Start Redis (default expected at `127.0.0.1:6379`).
2. Install packages:
   ```bash
   npm install
   ```
3. Start server:
   ```bash
   npm start
   ```

## API Endpoints
- `GET /api/status`
  - Shows total, sold, and remaining seats.
- `POST /api/book`
  - Books exactly 1 seat using Redis lock.
- `POST /api/reset`
  - Resets remaining seats to initial seat count.

## Run Load Test
```bash
npm run test:load
```

## Sample Response (`POST /api/book`)
```json
{
  "success": true,
  "bookingId": 1718369248709,
  "remaining": 99
}
```

## Notes on Concurrency Control
- Uses Redis `SET key value NX PX` for distributed lock acquisition.
- Uses Lua script to safely release lock only by lock owner.
- Prevents race conditions and double-booking under concurrent traffic.
