# Build context is the repository root: this is an npm workspaces monorepo,
# so the lockfile at the root is the only install that is reproducible.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY contracts/package.json contracts/package.json
RUN npm ci

FROM deps AS build
COPY backend backend
RUN npm --workspace backend run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# Generated PDFs live outside the image so a redeploy cannot delete a signed
# agreement. Must be writable by the unprivileged runtime user.
ENV REPORT_STORAGE_DIR=/data/reports

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist
# SQL migrations and the OpenAPI spec are read from disk at runtime.
COPY --from=build /app/backend/src/db/migrations ./backend/dist/db/migrations
COPY --from=build /app/backend/docker-entrypoint.sh ./backend/docker-entrypoint.sh
COPY --from=build /app/backend/openapi.yaml ./backend/openapi.yaml

# Strip CR so a Windows checkout cannot produce "#!/bin/sh\r".
RUN mkdir -p /data/reports && chown -R node:node /data \
 && sed -i 's/\r$//' /app/backend/docker-entrypoint.sh \
 && chmod +x /app/backend/docker-entrypoint.sh
USER node
VOLUME ["/data"]
EXPOSE 4000
ENTRYPOINT ["/app/backend/docker-entrypoint.sh"]
CMD ["node", "backend/dist/server.js"]
