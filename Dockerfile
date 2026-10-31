FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/generated ./generated
COPY --from=build /app/infra ./infra
COPY --from=build /app/app-runtime ./app-runtime
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts/start.mjs ./scripts/start.mjs
ENV NODE_ENV=production INK_OS_DATA_DIR=/data INK_OS_BIND=0.0.0.0 PORT=4318
EXPOSE 4318
CMD ["node", "scripts/start.mjs"]
