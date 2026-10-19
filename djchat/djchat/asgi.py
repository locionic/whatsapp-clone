"""
ASGI config for djchat project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/3.0/howto/deployment/asgi/
"""

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "djchat.settings")

# Import Django and Channels components after setting env var
import django
django.setup()

from django.core.asgi import get_asgi_application
from channels.auth import AuthMiddlewareStack
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.security.websocket import AllowedHostsOriginValidator

import chat.routing

def build_application():
    """Build the ASGI application."""
    http_application = get_asgi_application()
    websocket_application = AuthMiddlewareStack(URLRouter(chat.routing.websocket_urlpatterns))
    websocket_application = AllowedHostsOriginValidator(websocket_application)
    
    return ProtocolTypeRouter({
        "http": http_application,
        "websocket": websocket_application
    })

# Build application now that Django is configured
application = build_application()
