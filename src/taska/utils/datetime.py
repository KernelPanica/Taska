from datetime import UTC, datetime


def utc_now() -> datetime:
    """Return current UTC time as naive datetime (SQLite-compatible)."""
    return datetime.now(UTC).replace(tzinfo=None)


def to_naive_utc(value: datetime) -> datetime:
    """Normalize aware or naive datetime to naive UTC for comparisons."""
    if value.tzinfo is None:
        return value
    return value.astimezone(UTC).replace(tzinfo=None)
