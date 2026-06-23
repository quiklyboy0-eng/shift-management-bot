# Shift Management Bot

A premium shift management system for Discord with role-based department shifts, quota tracking, break management, online shift display, and wave-based leaderboards.

## Setup

1. Copy `.env.example` to `.env`.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Deploy slash commands:
   ```bash
   npm run deploy
   ```
4. Start the bot:
   ```bash
   npm start
   ```

## Commands

- `/shift manage` — Open a premium shift dashboard and start a shift.
- `/shift online` — View all users currently on shift.
- `/shift leaderboard` — View department leaderboards by wave.
