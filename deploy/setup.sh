#!/usr/bin/env bash
# Topload VPS bootstrap — Ubuntu 24.04, run as root from /opt/topload/deploy.
# Turns a blank box into the full machine: Node 22, deps, built UI, an
# always-on API service on port 80, and the complete ingest/backfill schedule.
#
# Usage (after `git clone … /opt/topload`):
#   cd /opt/topload/deploy && bash setup.sh
#
# Then from your Mac, copy secrets + database:
#   scp ~/Desktop/TOPLOAD/.env root@SERVER_IP:/opt/topload/.env
#   scp ~/Desktop/TOPLOAD/data/topload.db root@SERVER_IP:/opt/topload/data/
#   ssh root@SERVER_IP systemctl restart topload
set -euo pipefail
cd /opt/topload

echo "== Node 22 =="
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* && "$(node -v)" != v24* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "== Dependencies + build =="
npm ci
npm run build
mkdir -p data

echo "== systemd service (API + UI on :80) =="
cat > /etc/systemd/system/topload.service << 'UNIT'
[Unit]
Description=Topload card terminal (API + UI)
After=network.target

[Service]
WorkingDirectory=/opt/topload
ExecStart=/usr/bin/node --env-file-if-exists=.env server/api.js
Environment=PORT=80
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable topload
systemctl restart topload || true

echo "== Schedule (ingest 4x daily + nightly deep backfills) =="
NODE="$(command -v node)"
crontab << CRON
0 6 * * *  cd /opt/topload && $NODE --env-file-if-exists=.env server/ingest.js --if-stale >> data/ingest.log 2>&1
0 12 * * * cd /opt/topload && $NODE --env-file-if-exists=.env server/ingest.js --if-stale >> data/ingest.log 2>&1
0 18 * * * cd /opt/topload && $NODE --env-file-if-exists=.env server/ingest.js >> data/ingest.log 2>&1
0 0 * * *  cd /opt/topload && $NODE --env-file-if-exists=.env server/ingest.js --if-stale >> data/ingest.log 2>&1
0 21 * * * cd /opt/topload && HELIUS_MAX_PAGES=150 $NODE --env-file-if-exists=.env server/indexer-solana.js --backfill >> data/ingest.log 2>&1
0 22 * * * cd /opt/topload && ALCHEMY_MAX_WINDOWS=10 $NODE --env-file-if-exists=.env server/indexer-base.js --backfill >> data/ingest.log 2>&1
0 23 * * * cd /opt/topload && HELIUS_MAX_PAGES=100 $NODE --env-file-if-exists=.env server/indexer-phygitals.js --backfill >> data/ingest.log 2>&1
30 1 * * * cd /opt/topload && ALCHEMY_MAX_WINDOWS=4 $NODE --env-file-if-exists=.env server/indexer-courtyard.js --backfill >> data/ingest.log 2>&1
CRON
crontab -l

echo
echo "== DONE =="
echo "Next: scp your .env and data/topload.db over (see header of this script),"
echo "then: systemctl restart topload  — and open http://<this server's IP>"
