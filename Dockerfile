FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY app-runtime ./app-runtime
COPY package.json ./
COPY sdk/src ./sdk/src
COPY shared/continuation.mjs ./shared/continuation.mjs
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "app-runtime/index.mjs"]

FROM node:24-bookworm-slim AS platform
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/generated ./generated
COPY --from=build /app/infra ./infra
COPY --from=build /app/app-runtime ./app-runtime
COPY --from=build /app/cli ./cli
COPY --from=build /app/sdk ./sdk
COPY --from=build /app/ink ./ink
COPY --from=build /app/default-apps ./default-apps
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts/start.mjs ./scripts/start.mjs
ENV NODE_ENV=production INK_OS_DATA_DIR=/data INK_OS_BIND=0.0.0.0 PORT=4318
EXPOSE 4318
CMD ["node", "scripts/start.mjs"]
