#!/bin/sh
set -e

# Ensure /app/data volume directory exists and is writable
mkdir -p /app/data
chown -R node:node /app/data 2>/dev/null || true
chmod 777 /app/data 2>/dev/null || true

# If running as root, de-escalate to node user via gosu
if [ "$(id -u)" = "0" ]; then
    exec gosu node "$@"
else
    exec "$@"
fi
