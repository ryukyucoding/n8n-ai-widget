FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY python ./python
COPY bundles ./bundles
COPY schemas ./schemas

RUN pip3 install --no-cache-dir --break-system-packages -r python/requirements.txt

ENV WIDGET_MODIFY_BUNDLE=/app/bundles/modify
ENV WIDGET_DELETE_BUNDLE=/app/bundles/delete
ENV WIDGET_INSERT_BUNDLE=/app/bundles/insert
ENV WIDGET_DECOMPOSE_DIR=/app/bundles/decompose
ENV N8N_WIDGET_SCHEMA_ROOT=/app/schemas

EXPOSE 3001

CMD ["node", "src/index.js"]
