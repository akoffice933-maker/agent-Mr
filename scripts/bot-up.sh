#!/usr/bin/env bash
# Self-healing Telegram bot bootstrap + launch (sandbox-reset-proof).
#
# The sandbox restore wipes node_modules (and kills processes) between and even
# between steps, so this:
#   1. Restores telegram-bot deps if wiped (npm ci).
#   2. Refuses to start without a TELEGRAM_BOT_TOKEN (from @BotFather).
#   3. Loads .env and execs the bot (long polling — no public URL needed).
#
# Usage:  bash scripts/bot-up.sh
set -e
cd "$(dirname "$0")/.."

if [ ! -d telegram-bot/node_modules/grammy ]; then
  echo "restoring telegram-bot deps..."
  (cd telegram-bot && npm ci --no-audit --no-fund)
fi

if ! grep -q '^TELEGRAM_BOT_TOKEN=.' .env; then
  echo "TELEGRAM_BOT_TOKEN is empty in .env — create a bot with @BotFather and paste the token" >&2
  exit 1
fi

cd telegram-bot
set -a; . ../.env; set +a
exec npm run dev
