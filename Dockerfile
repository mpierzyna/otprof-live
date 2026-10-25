# Static app in an nginx image: built in a Node stage, only web/dist ends up in the final image.
# The forecast data are not part of the image: compose.yaml mounts them at /usr/share/nginx/html/data.
FROM node:24-slim AS build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM nginx:1.31.8
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
