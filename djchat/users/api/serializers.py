from rest_framework import serializers
from users.models import CustomUser


class UserSerializer(serializers.ModelSerializer):

    class Meta:
        model = CustomUser
        fields = ('id', 'username', 'email', 'tagline',)
        read_only_fields = ['username', 'email']


class EmailLookupSerializer(serializers.ModelSerializer):
    """`?email=` resolves an address to an account for the invite flow, and the
    flow reads only `id`. `username` stays because the app already shows it to
    peers everywhere else, and `email` echoes back what the caller just sent.

    `tagline` does not: it is a free-text bio, and this endpoint answers for any
    address any signed-in caller names, so it was a way to read other people's
    profiles by guessing addresses. The contact profile is where it belongs.
    """

    class Meta:
        model = CustomUser
        fields = ('id', 'username', 'email',)
