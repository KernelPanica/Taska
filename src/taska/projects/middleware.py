import json

from django.utils.translation import gettext as _


class ApiErrorsMiddleware:
    """Keep API errors JSON, including Django's 404/405/CSRF/500 responses."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if request.path.startswith("/api/") and response.status_code >= 400:
            errors = {
                400: ("invalid_request", _("Check your request and try again.")),
                401: ("authentication_required", _("Sign in to continue.")),
                403: ("permission_denied", _("You do not have permission to perform this action.")),
                404: ("not_found", _("This item is unavailable or you do not have access.")),
                405: ("method_not_allowed", _("This endpoint only supports GET requests.")),
            }
            code, message = errors.get(
                response.status_code, ("server_error", _("Something went wrong. Please try again."))
            )
            response.content = json.dumps({"error": {"code": code, "message": message}})
            response["Content-Type"] = "application/json"
            response["Content-Length"] = len(response.content)
        return response


class PrivateWorkspaceMiddleware:
    """Default-deny, including new views and unresolved routes."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from django.contrib.auth.views import redirect_to_login
        from django.http import JsonResponse
        from django.urls import Resolver404, resolve

        try:
            name = resolve(request.path_info).url_name
        except Resolver404:
            name = None
        public = name in {"login", "invite-accept", "set_language", "health"}
        # Django admin has its own login view, but all authentication uses our isolated page.
        if request.path_info.startswith("/admin/login/"):
            return redirect_to_login(request.GET.get("next", "/admin/"))
        if not request.user.is_authenticated and not public:
            if request.path_info.startswith("/api/"):
                return JsonResponse({}, status=401)
            return redirect_to_login(request.get_full_path())
        response = self.get_response(request)
        if name != "health":
            response["Cache-Control"] = "private, no-store"
            response["Referrer-Policy"] = "same-origin"
        return response
