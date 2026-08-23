# syntax=docker/dockerfile:1

FROM golang:1.25.7-bookworm AS build
WORKDIR /src/backend

COPY backend/go.mod backend/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY backend/ ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/ao-cloud ./cmd/ao-cloud && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/ao-cloud-migrate ./cmd/ao-cloud-migrate
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/ao ./cmd/ao

FROM debian:12-slim AS database-certs
# This staging image is deliberately regional. deploy-staging.sh rejects any
# region other than us-west-2 so the trust bundle and RDS endpoint stay aligned.
ARG RDS_CA_BUNDLE_SHA256=733b52e4b589586377e3e00f7c4625b61e14cbf0b5e08cace28b4f8aecc27c66
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && \
    curl -fsS --proto '=https' --tlsv1.2 \
      -o /rds-ca-bundle.pem \
      https://truststore.pki.rds.amazonaws.com/us-west-2/us-west-2-bundle.pem && \
    echo "${RDS_CA_BUNDLE_SHA256}  /rds-ca-bundle.pem" | sha256sum -c -

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build --chown=nonroot:nonroot /out/ao-cloud /ao-cloud
COPY --from=build --chown=nonroot:nonroot /out/ao-cloud-migrate /ao-cloud-migrate
COPY --from=build --chown=nonroot:nonroot /out/ao /ao
COPY --from=database-certs --chown=nonroot:nonroot /rds-ca-bundle.pem /etc/ssl/certs/rds-ca-bundle.pem
EXPOSE 8080
ENTRYPOINT ["/ao-cloud"]
