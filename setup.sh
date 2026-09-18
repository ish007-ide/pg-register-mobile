#!/usr/bin/env bash
# First-run setup. Safe to re-run; it won't overwrite an existing .env.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Copying env templates"
for c in backend recognition frontend; do
  if [ -f "$c/.env.example" ] && [ ! -f "$c/.env" ]; then
    cp "$c/.env.example" "$c/.env"
    echo "    $c/.env"
  else
    echo "    $c/.env already exists, left alone"
  fi
done

echo
echo "==> Installing backend dependencies"
(cd backend && npm install)

echo
echo "==> Installing frontend dependencies"
(cd frontend && npm install)

echo
echo "Done. Next:"
echo "  1. Set the same SERVICE_TOKEN in backend/.env, recognition/.env and frontend/.env"
echo "  2. npm test              # 90 tests, no camera or model needed"
echo "  3. npm run seed          # fake data so the UI has something to show"
echo "  4. npm run dev:api       # then, in another terminal, npm run dev:ui"
echo
echo "The recognition service is stage 3. Don't install it until the register"
echo "works on seeded data."
