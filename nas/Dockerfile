FROM python:3.13-alpine
WORKDIR /app
COPY --chown=65534:65534 agent.py /app/agent.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 65534:65534
CMD ["python3", "/app/agent.py"]
