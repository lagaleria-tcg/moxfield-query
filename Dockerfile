FROM node:22-bookworm

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev

RUN npx playwright install --with-deps chromium

COPY tsconfig.json ./
COPY src ./src

EXPOSE 10000

CMD ["npx", "tsx", "src/server.ts"]
