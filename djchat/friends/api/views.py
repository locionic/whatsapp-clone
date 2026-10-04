from rest_framework import status
from rest_framework.views import APIView
from rest_framework.response import Response

from django.shortcuts import get_object_or_404
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db.models import Q

from friends.exceptions import AlreadyExistsError, AlreadyFriendsError
from friends.models import Friend, FriendshipRequest

from .serializers import (
    UserSerializer,
    FriendshipRequestSerializer,
    FriendshipSentRequestSerializer
)

user_model = get_user_model()


class MyFriendsAPIView(APIView):
    """ View my friends """

    def get(self, request, format=None):
        friends = Friend.objects.friends(request.user)
        serializer = UserSerializer(friends, many=True)
        return Response(serializer.data)


class FriendshipAddAPIView(APIView):
    """ Create a FriendshipRequest """

    def post(self, request, user_id, format=None):
        to_user = get_object_or_404(user_model, id=user_id)
        from_user = request.user
        try:
            Friend.objects.add_friend(from_user, to_user)
        except AlreadyExistsError:
            return Response({'detail': 'Friendship request already exists.'}, status=status.HTTP_400_BAD_REQUEST)
        except AlreadyFriendsError:
            return Response({'detail': 'The users are already friends.'}, status=status.HTTP_400_BAD_REQUEST)
        except ValidationError as e:
            return Response({'detail': e.messages}, status=status.HTTP_400_BAD_REQUEST)
        return FriendshipSentRequestListAPIView.get(self, request)


class FriendshipRemoveAPIView(APIView):
    """ Create a FriendshipRequest """

    def post(self, request, user_id, format=None):
        to_user = get_object_or_404(user_model, id=user_id)
        from_user = request.user
        could_remove = Friend.objects.remove_friend(from_user, to_user)
        if could_remove:
            return Response(None, status=status.HTTP_204_NO_CONTENT)
        else:
            return Response({'detail': 'Friendship not found.'}, status=status.HTTP_404_NOT_FOUND)


class FriendshipAcceptAPIView(APIView):
    """ Accept a friendship request """

    def get(self, request, friendship_request_id, format=None):
        return FriendshipRequestDetailAPIView.get(self, request, friendship_request_id=friendship_request_id)

    def post(self, request, friendship_request_id, format=None):
        # A rejected request keeps its row -- that is how the receiver's
        # rejected list is built -- so friendship_requests_received still
        # holds it. Without this filter the rejecter could accept their own
        # dismissal and create the friendship they had just refused, without
        # the sender ever seeing an answer change.
        f_request = get_object_or_404(
            request.user.friendship_requests_received.filter(
                rejected__isnull=True),
            id=friendship_request_id
        )
        f_request.accept()
        return FriendshipRequestListAPIView.get(self, request)


class FriendshipRejectAPIView(APIView):
    """ Reject a friendship request """

    def get(self, request, friendship_request_id, format=None):
        return FriendshipRequestDetailAPIView.get(self, request, friendship_request_id=friendship_request_id)

    def post(self, request, friendship_request_id, format=None):
        f_request = get_object_or_404(
            request.user.friendship_requests_received, id=friendship_request_id
        )
        f_request.reject()
        return FriendshipRequestListAPIView.get(self, request)


class FriendshipCancelAPIView(APIView):
    """ Cancel a previously created friendship_request_id """

    def get(self, request, friendship_request_id, format=None):
        return FriendshipRequestDetailAPIView.get(self, request, friendship_request_id=friendship_request_id)

    def post(self, request, friendship_request_id, format=None):
        # The same filter the accept endpoint has, for the same reason. A
        # rejected request keeps its row -- that is how the receiver's rejected
        # list is built, and `add_friend` revives that same row if they ask
        # again -- but `friendship_requests_sent` still holds it, so cancelling
        # by id deleted the receiver's record of the dismissal. 404 rather than
        # 200: `sent_requests` already hides the row from the Sent tab, so
        # there was never a Cancel button pointing at it.
        f_request = get_object_or_404(
            request.user.friendship_requests_sent.filter(rejected__isnull=True),
            id=friendship_request_id
        )
        f_request.cancel()
        return FriendshipSentRequestListAPIView.get(self, request)


class FriendshipRequestListAPIView(APIView):
    """ View received friendship requests """

    def get(self, request, format=None):
        friendship_requests = Friend.objects.requests(request.user)
        serializer = FriendshipRequestSerializer(
            friendship_requests, many=True)
        return Response(serializer.data)


class FriendshipSentRequestListAPIView(APIView):
    """ View sent friendship requests """

    def get(self, request, format=None):
        friendship_requests = Friend.objects.sent_requests(request.user)
        serializer = FriendshipSentRequestSerializer(
            friendship_requests, many=True)
        return Response(serializer.data)


class FriendshipRequestListRejectedAPIView(APIView):
    """ View rejected friendship requests """

    def get(self, request, format=None):
        friendship_requests = Friend.objects.rejected_requests(request.user)
        serializer = FriendshipRequestSerializer(
            friendship_requests, many=True)
        return Response(serializer.data)


class FriendshipRequestDetailAPIView(APIView):
    """ View a particular friendship request """

    def get(self, request, friendship_request_id, format=None):
        f_request = get_object_or_404(
            FriendshipRequest.objects.filter(
                Q(from_user=request.user) | Q(to_user=request.user)),
            id=friendship_request_id)
        serializer = FriendshipRequestSerializer(
            f_request)
        return Response(serializer.data)
