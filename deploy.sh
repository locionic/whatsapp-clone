#!/usr/bin/env bash
#
# Build the frontend, then start the app.
#
# Why the build is here and not left to habit: djchat/static/dist/bundle.js is a
# committed build artifact (vue.config.js writes it there, publicPath
# /static/dist) and templates/index.html loads it directly. Editing
# frontend/src and restarting without rebuilding serves the OLD js, so the edit
# looks like it did nothing -- and the stale copy is what you are testing. Every
# past `deploy` commit here pairs a src edit with a dist edit, which is that
# ritual done by hand.
#
# REQUIRES NODE ON THE MACHINE THAT RUNS THIS. The app itself needs no Node at
# runtime, so if your deploy host has none, do not install this script as the
# host's start command -- run it on your build machine, or just run
# `cd djchat/frontend && npm ci && npm run build` there and commit the result,
# exactly as the existing commits do.
#
# Run with the virtualenv active (daphne and django live in it):
#   source venv/bin/activate && ./deploy.sh
#
# Required in the environment, or the deploy ships DEBUG=True, a SECRET_KEY that
# is public in this repo, and ALLOWED_HOSTS=['*'] to anyone who can reach :443:
#   DJANGO_DEBUG=false
#   DJANGO_SECRET_KEY=<a fresh random string>
#   DJANGO_ALLOWED_HOSTS=<the host you serve, comma-separated>

set -euo pipefail

cd "$(dirname "$0")"

: "${DJANGO_SUPERUSER_EMAIL:?export DJANGO_SUPERUSER_EMAIL}"
: "${DJANGO_SUPERUSER_USERNAME:?export DJANGO_SUPERUSER_USERNAME}"
: "${DJANGO_SUPERUSER_PASSWORD:?export DJANGO_SUPERUSER_PASSWORD}"

echo "==> building frontend into djchat/static/dist"
cd djchat/frontend
# NODE_OPTIONS is set by the package script itself; it is what lets webpack 4
# run on Node 22.
npm ci
npm run build
cd ../..

echo "==> migrating"
cd djchat
python manage.py migrate

# Unchanged from the documented start command, including its behaviour on a
# redeploy: createsuperuser --noinput exits non-zero when the user already
# exists, and `set -e` stops there before daphne, exactly as the `&&` chain did.
python manage.py createsuperuser --noinput

echo "==> serving"
exec daphne -e ssl:443 -b 0.0.0.0 djchat.asgi:application