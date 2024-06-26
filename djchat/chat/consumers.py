from channels.generic.websocket import AsyncWebsocketConsumer
import json
# import os
# import django
# os.environ.setdefault("DJANGO_SETTINGS_MODULE", "djchat.settings")
# django.setup()

class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.room_name = f'general_user_{self.scope["user"].id}'
        self.room_group_name = f'group_{self.room_name}'

        # Join room group
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        # Leave room group
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name)

    # Receive message from room group
    async def chat_message(self, event):

        # Send message to WebSocket
        await self.send(text_data=json.dumps({
            'message': event['message'],
            'data': event['data']
        }))
