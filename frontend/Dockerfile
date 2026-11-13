# Multi-stage build: compile the SPA, then serve static files with nginx.
# nginx also reverse-proxies /api to the api container, so the browser only
# ever talks to one origin (no CORS involved in the deployed setup).
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY contracts/package.json contracts/package.json
RUN npm ci
COPY frontend frontend
RUN npm --workspace frontend run build

FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
