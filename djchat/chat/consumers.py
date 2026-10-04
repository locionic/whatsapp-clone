from channels.generic.websocket import AsyncWebsocketConsumer
import json
# import os
# import django
# os.environ.setdefault("DJANGO_SETTINGS_MODULE", "djchat.settings")
# django.setup()

class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.room_group_name = None
        user = self.scope.get('user')
        # An anonymous socket has user.id of None, so it used to connect
        # happily into group_general_user_None. No user, no room.
        if user is None or user.is_anonymous:
            # close() rather than a bare return: without accept() *or* close()
            # the handshake is left hanging.
            await self.close(code=4001)
            return
        self.room_group_name = f'group_general_user_{user.id}'

        # Join room group
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        # Leave room group -- skipped when connect refused the socket
        if self.room_group_name:
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
