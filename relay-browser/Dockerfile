# yuce 浏览器中继：Playwright 官方镜像自带 Chromium 与系统依赖，Railway 检测到
# Dockerfile 会直接用它构建（Root Directory 填 relay-browser）。
FROM mcr.microsoft.com/playwright/python:v1.56.0-noble

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY browser_server.py .

ENV PYTHONUNBUFFERED=1 \
    PORT=8080 \
    RELAY_HEADLESS=1

EXPOSE 8080
CMD ["python", "-u", "browser_server.py"]
