from django.contrib import admin
from django.urls import path, include, re_path

from rest_framework.schemas import get_schema_view
from rest_framework import permissions

# https://django-registration.readthedocs.io/en/3.0.1/
from django_registration.backends.one_step.views import RegistrationView

from users.forms import CustomUserForm
from core.views import IndexTemplateView

schema_view = get_schema_view(
    title='Chat API',
    public=True,
    permission_classes=(permissions.AllowAny,),
)

urlpatterns = [
    # Django Admin
    path('admin/', admin.site.urls),

    # Django Registration Package
    path('accounts/register/',
         RegistrationView.as_view(
             form_class=CustomUserForm,
             success_url="/",
         ), name="django_registration_register"),
    path('accounts/', include('django_registration.backends.one_step.urls')),
    path('accounts/', include('django.contrib.auth.urls')),

    # DRF Auth Rest
    path('api/v1/', include('rest_framework.urls')),

    # Apps Endpoints
    path('api/v1/', include('chat.api.urls')),
    path('api/v1/', include('users.api.urls')),
    path('api/v1/', include('friends.api.urls')),

    # Swagger
    # Must not be 'api/v1/': include('rest_framework.urls') claims that path
    # with its API root, which would shadow this view.
    path('api/v1/schema/', schema_view),

    # Default
    re_path(r"^.*$", IndexTemplateView.as_view(), name="entry-point")
]
