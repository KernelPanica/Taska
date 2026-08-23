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

ROLE_PRESETS = {
    "software": {"name": "Разработка ПО", "codes": list(POSITION_CODES)},
    "product": {"name": "Продуктовая команда", "codes": ["B-S", "B-M", "F-S", "F-M", "Q-S", "Q-M", "PM-S", "PM-M", "TL-S"]},
    "small": {"name": "Небольшая команда", "codes": ["B-S", "F-S", "Q-S", "PM-S", "TL-S"]},
    "empty": {"name": "Без предустановленных ролей", "codes": []},
}
