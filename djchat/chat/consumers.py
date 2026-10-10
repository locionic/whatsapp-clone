from channels.generic.websocket import AsyncWebsocketConsumer
import json
# import os
# import django
# os.environ.setdefault("DJANGO_SETTINGS_MODULE", "djchat.settings")
# django.setup()

# The delivery receipts a message can reach the socket in, as the `kind` a
# producer puts in a receipt payload. Ordered by how far along the message is:
# each one means every state to its left has already happened.
#
# Two of the three carry the name of the group-wide condition rather than the
# plain one -- `all_received` is delivered, `all_read` is read -- because that is
# what they assert, and they only fire once the last participant has cleared the
# matching pending set. `sent` is per-author and fires on the way in.
#
# `sent` is deliberately not a state the clients draw differently: it means the
# server has the message, which they already know from the POST answering. What
# it exists for is the gap a plain HTTP receipt cannot see -- an answer that
# comes back without the message ever leaving the sending pool.
DELIVERY_RECEIPT_KINDS = ('sent', 'all_received', 'all_read')


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

    # A delivery receipt: a single message changing state, as opposed to
    # chat_message's "refetch this", which is the only other thing pushed here.
    #
    # Routed as its own channel-layer event rather than as a chat_message with
    # `message: 'update_message'`, because a receipt is worthless to a client
    # that does not recognise it: it names one kind and one message, and there
    # is no refetch behind it to recover from getting it wrong. That is the
    # whole difference between the two handlers -- chat_message forwards a
    # command the client already knows how to act on, this one validates
    # before forwarding. So an unknown kind, a missing field or a payload that
    # is not a dict are dropped here, where the drop is invisible, instead of
    # arriving as a mutation on `undefined` in a subscriber that had no way to
    # know it was being lied to.
    async def delivery_receipt(self, event):
        data = event.get('data')
        if not isinstance(data, dict):
            return
        if data.get('kind') not in DELIVERY_RECEIPT_KINDS:
            return
        message_id = data.get('message_id')
        # bool is an int, and `True` would sail through an `isinstance` check and
        # then key the client's receipt maps on 1.
        if not isinstance(message_id, int) or isinstance(message_id, bool):
            return
        # The client reads `data.kind` off the outer envelope and `message_id`
        # out of the nested dict -- that is the shape `chat_message` produces,
        # and one socket message is one handler for the browser to dispatch on.
        await self.send(text_data=json.dumps({
            'message': 'update_message',
            'data': {
                'kind': data['kind'],
                'message_id': data['message_id'],
            },
        }))
