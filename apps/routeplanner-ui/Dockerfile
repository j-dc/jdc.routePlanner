FROM node:24-alpine3.21 AS build
WORKDIR /app
COPY apps/routeplanner-ui/package.json apps/routeplanner-ui/package-lock.json ./
RUN npm ci
COPY apps/routeplanner-ui/ ./
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=build /app/dist/routeplanner-ui/browser /usr/share/nginx/html
COPY apps/routeplanner-ui/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080