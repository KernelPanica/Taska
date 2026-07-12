from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response

from taska import __version__
from taska.config import get_settings
from taska.routes import account, admin, auth, dashboard, invite, oauth, profiles, projects, setup
from taska.services.bootstrap import init_db
from taska.services.setup import is_setup_required

settings = get_settings()

SETUP_EXEMPT_PREFIXES = ("/static",)
SETUP_EXEMPT_PATHS = {"/health", "/setup"}


class SetupRequiredMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        path = request.url.path
        if path in SETUP_EXEMPT_PATHS or path.startswith(SETUP_EXEMPT_PREFIXES):
            return await call_next(request)

        import taska.database as database

        db = database.SessionLocal()
        try:
            if is_setup_required(db):
                return RedirectResponse("/setup", status_code=303)
        finally:
            db.close()

        return await call_next(request)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(
    title=settings.app_name,
    version=__version__,
    debug=settings.debug,
    lifespan=lifespan,
)

static_dir = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

app.add_middleware(SetupRequiredMiddleware)

app.include_router(setup.router)
app.include_router(auth.router)
app.include_router(oauth.router)
app.include_router(dashboard.router)
app.include_router(account.router)
app.include_router(profiles.router)
app.include_router(projects.router)
app.include_router(admin.router)
app.include_router(invite.router)


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


def run() -> None:
    uvicorn.run(
        "taska.main:app",
        host="0.0.0.0",
        port=8000,
        reload=settings.debug,
    )


if __name__ == "__main__":
    run()
