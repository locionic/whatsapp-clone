"""What ./deploy.sh has to do, pinned.

Two facts about the deploy are load-bearing and neither is visible to any other
test in this project.

The bundle is a committed artifact and nothing else builds it, so `npm run
build` living in the deploy script is the whole reason a frontend edit is not a
no-op -- before this, every `deploy` commit paired a src edit with a hand-run
build. And the app must be served with TLS, because the frontend hardcodes
`ws://` (see test_tutorial_route.py), which only reaches the socket when
something terminates TLS in front of the app.

Both are one-line edits that would fail silently: drop the build and the app
serves yesterday's js; drop `-e ssl:443` and the tutorial page's socket dies.
"""

from pathlib import Path


DEPLOY_SH = Path(__file__).resolve().parents[3] / 'deploy.sh'


def _commands():
    """The script's executable lines.

    Comments are dropped because the header mentions daphne while explaining
    that the app does *not* need node at runtime -- matching the bare word
    would order the build against a sentence instead of against the serve.
    """
    return [line.strip()
            for line in DEPLOY_SH.read_text(encoding='utf-8').splitlines()
            if line.strip() and not line.strip().startswith('#')]


def test_the_deploy_builds_the_bundle_before_it_serves():
    commands = _commands()

    assert 'npm ci' in commands
    build = commands.index('npm run build')
    serve = next(i for i, c in enumerate(commands) if 'daphne' in c)
    # A build after daphne starts is not a build: it would land in a directory
    # nobody is serving yet, which is the stale-bundle trap all over again.
    assert build < serve


def test_the_deploy_serves_the_asgi_app_over_tls():
    serve = next(c for c in _commands() if 'daphne' in c)

    assert 'daphne -e ssl:443 -b 0.0.0.0 djchat.asgi:application' in serve