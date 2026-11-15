FROM python:3.13-alpine
WORKDIR /app
COPY --chown=65534:65534 agent.py /app/agent.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENV MEETING_URL=https://home.sunny-string.cn/meeting/ \
    WOL_AGENT_KEY="" \
    WOL_BROADCAST=192.168.31.255 \
    WOL_BASEMENT_MAC=22-18-4D-11-5D-C0 \
    WOL_SMALL_ROOM_MAC=B8-88-E3-F9-AD-19
USER 65534:65534
CMD ["python3", "/app/agent.py"]
