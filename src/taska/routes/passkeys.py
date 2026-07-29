from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from taska.auth.dependencies import get_current_user
from taska.auth.oauth import login_response
from taska.auth.passkeys import (
    authentication_options,
    registration_options,
    serialize_options,
    verify_and_store_registration,
    verify_authentication,
)
from taska.auth.security import (
    create_webauthn_challenge_token,
    decode_webauthn_challenge_token,
)
from taska.config import get_settings
from taska.database import get_db
from taska.models.passkey import PasskeyCredential
from taska.models.user import User

router = APIRouter(prefix="/auth/passkey", tags=["passkeys"])
CHALLENGE_COOKIE = "taska_webauthn_challenge"


class CredentialRequest(BaseModel):
    credential: dict
    name: str = "Passkey"


@router.post("/register/options")
def register_options(
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user is None:
        raise HTTPException(status_code=401, detail="Требуется вход")
    credentials = list(
        db.scalars(select(PasskeyCredential).where(PasskeyCredential.user_id == user.id)).all()
    )
    options = registration_options(user, credentials)
    response = JSONResponse(serialize_options(options))
    response.set_cookie(
        CHALLENGE_COOKIE,
        create_webauthn_challenge_token(options.challenge, "registration"),
        httponly=True,
        secure=get_settings().webauthn_origin.startswith("https://"),
        samesite="strict",
        max_age=300,
    )
    return response


@router.post("/register/verify")
def register_verify(
    payload: CredentialRequest,
    request: Request,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user is None:
        raise HTTPException(status_code=401, detail="Требуется вход")
    challenge = decode_webauthn_challenge_token(
        request.cookies.get(CHALLENGE_COOKIE, ""), "registration"
    )
    if challenge is None:
        raise HTTPException(status_code=400, detail="Challenge истёк, попробуйте снова")
    try:
        passkey = verify_and_store_registration(
            db, user, payload.credential, challenge, payload.name
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    response = JSONResponse({"ok": True, "id": passkey.id, "name": passkey.name})
    response.delete_cookie(CHALLENGE_COOKIE)
    return response


@router.post("/login/options")
def login_options():
    options = authentication_options()
    response = JSONResponse(serialize_options(options))
    response.set_cookie(
        CHALLENGE_COOKIE,
        create_webauthn_challenge_token(options.challenge, "authentication"),
        httponly=True,
        secure=get_settings().webauthn_origin.startswith("https://"),
        samesite="strict",
        max_age=300,
    )
    return response


@router.post("/login/verify")
def login_verify(payload: CredentialRequest, request: Request, db: Session = Depends(get_db)):
    challenge = decode_webauthn_challenge_token(
        request.cookies.get(CHALLENGE_COOKIE, ""), "authentication"
    )
    if challenge is None:
        raise HTTPException(status_code=400, detail="Challenge истёк, попробуйте снова")
    try:
        user = verify_authentication(db, payload.credential, challenge)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    response = login_response(user)
    response.delete_cookie(CHALLENGE_COOKIE)
    return response


@router.delete("/{credential_id}")
def delete_passkey(
    credential_id: int,
    user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user is None:
        raise HTTPException(status_code=401, detail="Требуется вход")
    passkey = db.scalar(
        select(PasskeyCredential).where(
            PasskeyCredential.id == credential_id, PasskeyCredential.user_id == user.id
        )
    )
    if passkey is None:
        raise HTTPException(status_code=404, detail="Passkey не найден")
    db.delete(passkey)
    db.commit()
    return {"ok": True}
