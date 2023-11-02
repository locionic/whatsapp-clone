"""
ASGI config for djchat project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/3.0/howto/deployment/asgi/
"""

# import os
# from django.core.asgi import get_asgi_application
# os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'djchat.settings')
# application = get_asgi_application()

# daphne
# import os
# from channels.routing import get_default_application
# import django
# os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'djchat.settings')
# django.setup()
# application = get_default_application()

# docs tutor
# import os
# from channels.routing import ProtocolTypeRouter
# from django.core.asgi import get_asgi_application
# from channels.auth import AuthMiddlewareStack
# from channels.routing import ProtocolTypeRouter, URLRouter
# import chat.routing
# os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'djchat.settings')
# application = ProtocolTypeRouter({
#     "http": get_asgi_application(),
#     'websocket': AuthMiddlewareStack(
#         URLRouter(
#             chat.routing.websocket_urlpatterns
#         )
#     ),
# })

import os
import django
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "djchat.settings")
django.setup()
from django.core.asgi import get_asgi_application
from channels.auth import AuthMiddlewareStack
from channels.routing import ProtocolTypeRouter, URLRouter
import chat.routing
application = ProtocolTypeRouter({
    "http": get_asgi_application(),
     "websocket": AuthMiddlewareStack(
         URLRouter(
            chat.routing.websocket_urlpatterns
        )
    ),
})
