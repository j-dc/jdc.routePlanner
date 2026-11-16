FROM node:24-alpine3.21 AS build
WORKDIR /app
COPY apps/review-web/package.json apps/review-web/package-lock.json ./
RUN npm ci
COPY apps/review-web/ ./
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=build /app/dist/review-web/browser /usr/share/nginx/html
COPY apps/review-web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080