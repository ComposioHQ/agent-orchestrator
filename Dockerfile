# syntax=docker/dockerfile:1

FROM golang:1.26.5-bookworm AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY . .
ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/ao-cloud ./cmd/ao-cloud && \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/ao-cloud-migrate ./cmd/ao-cloud-migrate && \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/ao-cloud-healthcheck ./cmd/ao-cloud-healthcheck && \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/ao-worker ./cmd/ao-worker

FROM debian:12.11-slim AS worker
RUN apt-get update && \
    apt-get install --yes --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        openssh-client \
        procps && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 10001 ao-worker && \
    useradd --uid 10001 --gid ao-worker --home-dir /workspace/.ao/home --shell /bin/bash ao-worker && \
    mkdir -p /workspace/repository /workspace/.ao/home && \
    chown -R ao-worker:ao-worker /workspace
COPY --from=build --chown=ao-worker:ao-worker /out/ao-worker /ao-worker
USER ao-worker
WORKDIR /workspace/repository
ENTRYPOINT ["/ao-worker"]

FROM gcr.io/distroless/static-debian12:nonroot AS control-plane
COPY --from=build --chown=nonroot:nonroot /out/ao-cloud /ao-cloud
COPY --from=build --chown=nonroot:nonroot /out/ao-cloud-migrate /ao-cloud-migrate
COPY --from=build --chown=nonroot:nonroot /out/ao-cloud-healthcheck /ao-cloud-healthcheck
COPY --from=build --chown=nonroot:nonroot /out/ao-worker /ao-worker
EXPOSE 8080
ENTRYPOINT ["/ao-cloud"]
