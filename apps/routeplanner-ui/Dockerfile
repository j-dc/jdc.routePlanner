FROM node:26.13.1-alpine AS build
WORKDIR /app
COPY apps/routeplanner-ui/package.json apps/routeplanner-ui/package-lock.json ./
RUN npm ci
COPY apps/routeplanner-ui/ ./
RUN npm run build

FROM nginx/nginx-unprivileged:1.31-alpine3.24 AS runtime
COPY --from=build /app/dist/routeplanner-ui/browser /usr/share/nginx/html
COPY assets/logo.png /usr/share/nginx/html/assets/logo.png
COPY apps/routeplanner-ui/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080