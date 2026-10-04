from django.core.management.base import BaseCommand, CommandError
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

channel_layer = get_channel_layer()


class Command(BaseCommand):
    help = 'Send push notifications to clients'

    def add_arguments(self, parser):
        parser.add_argument('user_id', type=int)

    def handle(self, *args, **options):
        # ChatConsumer.connect joins f'group_general_user_{id}', and its
        # chat_message handler reads both 'message' and 'data' -- sending
        # anywhere else, or omitting 'data', is a silent no-op or a KeyError.
        async_to_sync(channel_layer.group_send)(
            f"group_general_user_{options['user_id']}", {
                "type": "chat_message",
                "message": "testeando esto",
                "data": {}
            })
        self.stdout.write(self.style.SUCCESS('hola'))
