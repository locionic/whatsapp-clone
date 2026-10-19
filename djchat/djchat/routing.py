from channels.auth import AuthMiddlewareStack
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.security.websocket import AllowedHostsOriginValidator

import chat.routing

def build_application():
    """Build the ASGI application - call this after Django is configured."""
    websocket_application = AuthMiddlewareStack(URLRouter(chat.routing.websocket_urlpatterns))
    websocket_application = AllowedHostsOriginValidator(websocket_application)
    
    return ProtocolTypeRouter({
        "websocket": websocket_application
    })

# Lazy application - only built when accessed
_application = None

def __getattr__(name):
    global _application
    if name == "application":
        if _application is None:
            _application = build_application()
        return _application
    raise AttributeError(f"module '{__name__}' has no attribute '{name}'")
