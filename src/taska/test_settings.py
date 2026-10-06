import os
import tempfile
from pathlib import Path

from .settings import *  # noqa: F403

SECRET_KEY = "isolated-test-settings-only"
DEBUG = False
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}
SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
SECURE_SSL_REDIRECT = False

# Live browser requests (including avatars) need separate database connections.
# Django shares one connection across threads for in-memory live-server databases.

if os.environ.get("RUN_BROWSER") == "1":
    _browser_database = tempfile.TemporaryDirectory(prefix="taska-browser-db-")
    DATABASES["default"]["TEST"] = {"NAME": str(Path(_browser_database.name) / "test.sqlite3")}
