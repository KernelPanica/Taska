import re

from taska.auth.security import decrypt_full_name, encrypt_full_name

TOKEN_PATTERN = re.compile(
    r"^(?P<position>[A-Za-z0-9]+-[A-Za-z])(?P<experience>\d+)_(?P<cipher>[A-Za-z0-9_\-=]+)$"
)

POSITION_CODES = {
    "B-S": "Backend · Senior",
    "B-M": "Backend · Middle",
    "B-J": "Backend · Junior",
    "F-S": "Frontend · Senior",
    "F-M": "Frontend · Middle",
    "F-J": "Frontend · Junior",
    "D-S": "DevOps · Senior",
    "D-M": "DevOps · Middle",
    "Q-S": "QA · Senior",
    "Q-M": "QA · Middle",
    "PM-S": "PM · Senior",
    "PM-M": "PM · Middle",
    "TL-S": "Team Lead · Senior",
}


def build_member_token(position_code: str, experience_years: int, full_name: str) -> str:
    position = position_code.strip().upper()
    if "-" not in position:
        msg = "Код должности должен быть в формате ROLE-GRADE, например PM-S"
        raise ValueError(msg)

    if experience_years < 0 or experience_years > 50:
        msg = "Стаж должен быть от 0 до 50 лет"
        raise ValueError(msg)

    cipher = encrypt_full_name(full_name)
    return f"{position}{experience_years}_{cipher}"


def parse_member_token(token: str) -> dict[str, str | int]:
    match = TOKEN_PATTERN.match(token.strip())
    if not match:
        msg = (
            "Неверный формат токена. Ожидается: "
            "ДОЛЖНОСТЬ-ГРЕЙДСТАЖ_шифрФИО (пример: PM-S1_...)"
        )
        raise ValueError(msg)

    position = match.group("position")
    experience = int(match.group("experience"))
    cipher = match.group("cipher")
    full_name = decrypt_full_name(cipher)

    return {
        "position_code": position,
        "position_label": POSITION_CODES.get(position, position),
        "experience_years": experience,
        "full_name": full_name,
        "cipher": cipher,
        "token_prefix": f"{position}{experience}",
    }
