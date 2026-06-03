# Multi-stage build: node compiles the static site, nginx serves the result.
# Final image is ~25 MB (alpine nginx + a few hundred kB of JS/CSS).

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --include=dev
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
