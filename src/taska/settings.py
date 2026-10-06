import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parents[2]
DEBUG = os.environ.get("TASKA_DEBUG", "true").lower() == "true"
SECRET_KEY = os.environ.get("TASKA_SECRET_KEY", "")
if not SECRET_KEY:
    if not DEBUG:
        raise ImproperlyConfigured("Set TASKA_SECRET_KEY when TASKA_DEBUG=false.")
    SECRET_KEY = "development-only-do-not-use-in-production"
ALLOWED_HOSTS = os.environ.get("TASKA_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]").split(",")
CSRF_TRUSTED_ORIGINS = [
    origin for origin in os.environ.get("TASKA_CSRF_TRUSTED_ORIGINS", "").split(",") if origin
]
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "taska.todos",
    "taska.projects",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.locale.LocaleMiddleware",
    "taska.projects.middleware.ApiErrorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "taska.projects.middleware.PrivateWorkspaceMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "taska.urls"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "src/taska/templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
                "taska.projects.views.navigation",
            ]
        },
    }
]
WSGI_APPLICATION = "taska.wsgi.application"
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": os.environ.get("TASKA_DATABASE_PATH", str(BASE_DIR / "db.sqlite3")),
    }
}
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
LANGUAGE_CODE = "en-us"
LANGUAGES = [("en", "English"), ("ru", "Русский")]
LOCALE_PATHS = [Path(__file__).resolve().parent / "locale"]
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "src/taska/static"]
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
LOGIN_URL = "login"
LOGIN_REDIRECT_URL = "todos"
LOGOUT_REDIRECT_URL = "login"
SESSION_COOKIE_HTTPONLY = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SESSION_COOKIE_SECURE = os.environ.get("TASKA_HTTPS", "false").lower() == "true"
CSRF_COOKIE_SECURE = SESSION_COOKIE_SECURE
SECURE_SSL_REDIRECT = SESSION_COOKIE_SECURE
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "loggers": {"django.request": {"handlers": ["console"], "level": "ERROR", "propagate": False}},
}

# Uploads are deliberately never served by staticfiles or a public media route.
MEDIA_ROOT = Path(os.environ.get("TASKA_MEDIA_ROOT", str(BASE_DIR / "private-media")))
TASKA_FILE_LIMIT = int(os.environ.get("TASKA_FILE_LIMIT", 50 * 1024 * 1024))
TASKA_SUBMISSION_LIMIT = int(os.environ.get("TASKA_SUBMISSION_LIMIT", 100 * 1024 * 1024))
TASKA_EMAIL_ENABLED = os.environ.get("TASKA_EMAIL_ENABLED", "false").lower() == "true"
TASKA_PUBLIC_URL = os.environ.get("TASKA_PUBLIC_URL", "http://localhost:8000").rstrip("/")
EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
EMAIL_HOST = os.environ.get("TASKA_SMTP_HOST", "localhost")
EMAIL_PORT = int(os.environ.get("TASKA_SMTP_PORT", "587"))
EMAIL_HOST_USER = os.environ.get("TASKA_SMTP_USER", "")
EMAIL_HOST_PASSWORD = os.environ.get("TASKA_SMTP_PASSWORD", "")
EMAIL_USE_TLS = os.environ.get("TASKA_SMTP_TLS", "true").lower() == "true"
EMAIL_TIMEOUT = 20
DEFAULT_FROM_EMAIL = os.environ.get("TASKA_FROM_EMAIL", "taska@localhost")
