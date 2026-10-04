from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework import generics
from rest_framework.exceptions import ParseError, ValidationError

from django.http import Http404
from django.contrib.auth import get_user_model

from users.api.serializers import EmailLookupSerializer, UserSerializer

User = get_user_model()


class UsersAPIView(APIView):
    def get(self, request):
        email = request.GET.get('email', '')
        # Not optional. Defaulting to '' turned a request with no ?email= into
        # a lookup for blank-address accounts: 200 with one of them, and a 500
        # once two existed.
        if not email:
            raise ParseError(detail='An email address is required.')
        # email is not unique at the DB level -- only django_registration's form
        # checks that, and createsuperuser2/UserAdmin do not go through it. get()
        # over a non-unique field lets MultipleObjectsReturned escape as a 500,
        # so count the matches instead of reaching for get_object_or_404.
        matches = User.objects.filter(email=email)[:2]
        if len(matches) > 1:
            raise ValidationError(
                'That address matches more than one account.')
        if not matches:
            raise Http404
        # Not UserSerializer: this answers for any address the caller names, and
        # the shared one carries `tagline`, a free-text bio. See the serializer.
        serializer = EmailLookupSerializer(matches[0])
        return Response(serializer.data)


class CurrentUserAPIView(generics.RetrieveUpdateAPIView):
    serializer_class = UserSerializer

    def get_queryset(self):
        return self.request.user

    def get_object(self):
        return self.get_queryset()
