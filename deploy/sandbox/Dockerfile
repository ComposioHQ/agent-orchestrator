# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# The complete base index is digest-pinned. Build with --platform=linux/amd64
# for Daytona's current worker architecture.
FROM golang:1.25.7-bookworm@sha256:564e366a28ad1d70f460a2b97d1d299a562f08707eb0ecb24b659e5bd6c108e1 AS build

WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags='-s -w -buildid=' -o /out/ao-sandbox ./cmd/ao-sandbox

# Keep git, a POSIX shell, and the public CA bundle from the same immutable base.
# Agent CLIs are supplied by the provider snapshot; this image does not bake
# customer/provider credentials or an AO daemon.
FROM golang:1.25.7-bookworm@sha256:564e366a28ad1d70f460a2b97d1d299a562f08707eb0ecb24b659e5bd6c108e1

RUN useradd --create-home --home-dir /home/ao --uid 10001 ao \
    && install -d -o ao -g ao -m 0700 /run/ao /run/ao/secrets \
    && install -d -o ao -g ao -m 0750 /workspace
COPY --from=build --chown=root:root /out/ao-sandbox /usr/local/bin/ao-sandbox

USER 10001:10001
WORKDIR /workspace
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/ao-sandbox"]
