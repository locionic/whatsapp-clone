# Generated by Django 3.0.1 on 2020-01-06 22:04

from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('chat', '0008_message_front_key'),
    ]

    operations = [
        migrations.AddField(
            model_name='message',
            name='pending_read',
            field=models.ManyToManyField(related_name='unread_messages', to=settings.AUTH_USER_MODEL),
        ),
    ]
