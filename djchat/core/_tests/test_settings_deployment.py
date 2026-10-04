"""The three settings that decide how the app behaves when it is exposed.

`problems.txt` starts this project as
`daphne -e ssl:443 -b 0.0.0.0 djchat.asgi:application`, so these literals were
being served to the public: DEBUG=True turned any unhandled exception into a
traceback with its local variables, ALLOWED_HOSTS=['*'] accepted every Host
header, and SECRET_KEY was a constant in the repo. They now read the
environment, defaulting to exactly what they used to be.

django.conf.settings is already built by the time these run, so each test loads
an independent copy of the module off disk under a throwaway name -- otherwise
`importlib.reload` would fight the live settings object.
"""

import importlib.util
from pathlib import Path

import pytest


SETTINGS_PY = Path(__file__).resolve().parents[2] / 'djchat' / 'settings.py'


def load_settings(monkeypatch, **env):
    """Execute djchat/settings.py from scratch with `env` in os.environ."""
    for name in ('DJANGO_DEBUG', 'DJANGO_SECRET_KEY', 'DJANGO_ALLOWED_HOSTS'):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)

    spec = importlib.util.spec_from_file_location('settings_probe', SETTINGS_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_development_defaults_are_unchanged(monkeypatch):
    """runserver must still work with nothing exported."""
    module = load_settings(monkeypatch)

    assert module.DEBUG is True
    assert module.ALLOWED_HOSTS == ['*']
    assert module.SECRET_KEY


def test_debug_can_be_turned_off_from_the_environment(monkeypatch):
    module = load_settings(monkeypatch, DJANGO_DEBUG='false')

    assert module.DEBUG is False


def test_allowed_hosts_takes_a_comma_separated_list(monkeypatch):
    module = load_settings(
        monkeypatch,
        DJANGO_ALLOWED_HOSTS='chat.example.com,www.chat.example.com')

    assert module.ALLOWED_HOSTS == [
        'chat.example.com', 'www.chat.example.com']


def test_the_secret_key_can_be_replaced_from_the_environment(monkeypatch):
    """A key published in the repo signs every session cookie and auth token
    the app hands out, so it has to be replaceable without a code change."""
    module = load_settings(monkeypatch, DJANGO_SECRET_KEY='set-by-the-deployment')

    assert module.SECRET_KEY == 'set-by-the-deployment'