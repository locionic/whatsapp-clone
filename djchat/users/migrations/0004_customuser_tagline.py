# Generated by Django 3.0.1 on 2020-01-21 19:02

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('users', '0003_auto_20200110_0439'),
    ]

    operations = [
        migrations.AddField(
            model_name='customuser',
            name='tagline',
            field=models.TextField(blank=True, default='', max_length=1024, verbose_name='description'),
        ),
    ]
