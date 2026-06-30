# syntax=docker/dockerfile:1
# Multi-stage build: compile the React UI and the Go API, then ship a single
# small image where the Go binary serves BOTH the API and the built UI.

# ---- 1. build the frontend ----
FROM node:20-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build            # -> /web/dist

# ---- 2. build the backend ----
FROM golang:1.24-alpine AS api
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
# Migrations are embedded via go:embed, so the binary is self-contained.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/lumina .

# ---- 3. runtime ----
FROM alpine:3.20
RUN adduser -D -u 10001 lumina
WORKDIR /app
COPY --from=api /out/lumina /app/lumina
COPY --from=web /web/dist   /app/web
ENV LUMINA_ADDR=:8080 \
    LUMINA_FRONTEND_DIR=/app/web \
    LUMINA_DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R lumina /app
USER lumina
EXPOSE 8080
CMD ["/app/lumina"]
