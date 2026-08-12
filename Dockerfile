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

FROM gcr.io/distroless/static-debian12:nonroot AS worker
COPY --from=build --chown=nonroot:nonroot /out/ao-worker /ao-worker
ENTRYPOINT ["/ao-worker"]

FROM gcr.io/distroless/static-debian12:nonroot AS control-plane
COPY --from=build --chown=nonroot:nonroot /out/ao-cloud /ao-cloud
COPY --from=build --chown=nonroot:nonroot /out/ao-cloud-migrate /ao-cloud-migrate
COPY --from=build --chown=nonroot:nonroot /out/ao-cloud-healthcheck /ao-cloud-healthcheck
COPY --from=build --chown=nonroot:nonroot /out/ao-worker /ao-worker
EXPOSE 8080
ENTRYPOINT ["/ao-cloud"]
