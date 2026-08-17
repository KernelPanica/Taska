FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src

WORKDIR /app

RUN addgroup --system taska && adduser --system --ingroup taska taska

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY src ./src
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN mkdir -p /data && chown -R taska:taska /app /data

USER taska
EXPOSE 8000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
