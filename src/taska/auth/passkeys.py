import json

from sqlalchemy import select
from sqlalchemy.orm import Session
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from taska.config import get_settings
from taska.models.passkey import PasskeyCredential
from taska.models.user import User
from taska.utils.datetime import utc_now


def registration_options(user: User, credentials: list[PasskeyCredential]):
    settings = get_settings()
    return generate_registration_options(
        rp_id=settings.webauthn_rp_id,
        rp_name=settings.webauthn_rp_name,
        user_id=str(user.id).encode(),
        user_name=user.username,
        user_display_name=user.display_name or user.username,
        exclude_credentials=[
            PublicKeyCredentialDescriptor(id=credential.credential_id)
            for credential in credentials
        ],
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
    )


def authentication_options():
    settings = get_settings()
    return generate_authentication_options(
        rp_id=settings.webauthn_rp_id,
        user_verification=UserVerificationRequirement.REQUIRED,
    )


def serialize_options(options) -> dict:
    return json.loads(options_to_json(options))


def verify_and_store_registration(
    db: Session,
    user: User,
    credential_payload: dict,
    expected_challenge: bytes,
    name: str,
) -> PasskeyCredential:
    settings = get_settings()
    verification = verify_registration_response(
        credential=credential_payload,
        expected_challenge=expected_challenge,
        expected_rp_id=settings.webauthn_rp_id,
        expected_origin=settings.webauthn_origin,
        require_user_verification=True,
    )
    existing = db.scalar(
        select(PasskeyCredential).where(
            PasskeyCredential.credential_id == verification.credential_id
        )
    )
    if existing is not None:
        raise ValueError("Этот passkey уже зарегистрирован")

    transports = credential_payload.get("response", {}).get("transports", [])
    passkey = PasskeyCredential(
        user_id=user.id,
        credential_id=verification.credential_id,
        public_key=verification.credential_public_key,
        sign_count=verification.sign_count,
        device_type=str(verification.credential_device_type.value),
        backed_up=verification.credential_backed_up,
        transports=",".join(transports),
        name=name.strip()[:128] or "Passkey",
    )
    db.add(passkey)
    db.commit()
    db.refresh(passkey)
    return passkey


def verify_authentication(
    db: Session, credential_payload: dict, expected_challenge: bytes
) -> User:
    raw_id = credential_payload.get("rawId") or credential_payload.get("id")
    if not raw_id:
        raise ValueError("Passkey не содержит идентификатор")
    credential_id = base64url_to_bytes(raw_id)
    passkey = db.scalar(
        select(PasskeyCredential).where(PasskeyCredential.credential_id == credential_id)
    )
    if passkey is None:
        raise ValueError("Passkey не зарегистрирован")

    settings = get_settings()
    verification = verify_authentication_response(
        credential=credential_payload,
        expected_challenge=expected_challenge,
        expected_rp_id=settings.webauthn_rp_id,
        expected_origin=settings.webauthn_origin,
        credential_public_key=passkey.public_key,
        credential_current_sign_count=passkey.sign_count,
        require_user_verification=True,
    )
    passkey.sign_count = verification.new_sign_count
    passkey.last_used_at = utc_now()
    db.commit()
    user = db.get(User, passkey.user_id)
    if user is None:
        raise ValueError("Пользователь passkey не найден")
    return user
