# Docker deployment

Release images are published for `linux/amd64` and `linux/arm64` at
`ghcr.io/gisenberg/wmux`. The Compose stack can pull one of those images or
build directly from a normal wmux checkout. It runs as the unprivileged `node`
user and stores wmux state, generated auth tokens, settings, and durable session
metadata in the `wmux-data` volume.

## Start

From the repository root:

```bash
cp deploy/docker/.env.example deploy/docker/.env
WMUX_IMAGE=ghcr.io/gisenberg/wmux:0.1.2 \
  docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml pull
WMUX_IMAGE=ghcr.io/gisenberg/wmux:0.1.2 \
  docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml up -d --no-build
```

Use an immutable version tag for normal deployments. The moving `0.1` and
`latest` tags are also published. To build the checkout instead:

```bash
docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml up -d --build
```

The published port defaults to `127.0.0.1:3478`, suitable for a reverse proxy
on the Docker host. Follow startup and token output with:

```bash
docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml logs -f wmux
```

For direct access over a private network, set `WMUX_PUBLISH_HOST` to one
specific Tailscale or RFC1918 address and set `WMUX_PUBLIC_URL` to the URL at
that address. If managed remote machines need a different private route for
staged helpers and hooks, set `WMUX_HELPER_URL` to that reachable callback URL;
browser links continue to use `WMUX_PUBLIC_URL`.
When a reverse proxy or non-`*.ts.net` DNS name is used, set the same reachable
`WMUX_PUBLIC_URL` and add the hostname to `WMUX_ALLOWED_HOSTS`. The proxy must
forward WebSocket upgrades for `/ws/*`.

For features that resolve a caller from forwarded headers, such as dynamic host
registration in builds that include it, set `WMUX_TRUSTED_PROXIES` to the
proxy's exact IP as observed by wmux inside the container. With a proxy on the
Docker host this is often the container network's gateway, not the host address
used by clients. Inspect the supplied Compose network after it exists:

```bash
docker network inspect "${COMPOSE_PROJECT_NAME:-wmux}_default" \
  --format '{{(index .IPAM.Config 0).Gateway}}'
```

Use that result only after confirming the proxy reaches wmux through the
published port on that bridge. Re-check it whenever the Compose network is
deleted or recreated because Docker may allocate a different subnet. Do not use
a wildcard, hostname, or CIDR.

The entrypoint rejects wildcard, public, and non-IP `WMUX_PUBLISH_HOST` values
before wmux starts. Docker creates its port-forwarding rule before container
startup, so an invalid setting may briefly leave a rule with no listening wmux
process; correct the value and recreate the container. Do not bypass the image
entrypoint.

The supplied Compose file is the supported network boundary. A raw command such
as `docker run -p 3478:3478 ...` publishes on every host interface before the
container can inspect it. If raw Docker invocation is unavoidable, bind the
host side explicitly (for example `-p 127.0.0.1:3478:3478`) and pass the same
address as `WMUX_PUBLISH_HOST`.

`WMUX_HOST` is intentionally different from `WMUX_PUBLISH_HOST`. It controls
the address inside the container. Leave it unset in normal deployments: the
entrypoint selects a private IPv4 address on the container's default-route
interface. Explicit values are restricted to non-loopback Tailscale, RFC1918,
or IPv6 ULA addresses, preserving wmux's private-network bind policy. Loopback
is not valid for this internal bind because Docker's published traffic arrives
on the container network interface rather than container loopback.

## Machine and SSH configuration

No checkout configuration, `.env` file, SSH key, or wmux secret is copied into
the image. Without a mounted config, wmux exposes only its local container
machine. `wmux.config.example.json` is a generic remote-machine example and
uses `"localMachine": false` to suppress that container-local shell. Put the
real config outside the checkout, then add a second Compose file when remote
machines are needed:

```yaml
services:
  wmux:
    volumes:
      - /absolute/path/to/wmux.config.json:/home/node/.wmux/config.json:ro
      - /absolute/path/to/.ssh:/home/node/.ssh:ro
```

Pass both files to Compose, with the override last. Ensure the mounted files
are readable by the container's `node` user (UID 1000 in the standard image).
For a read-only SSH mount, pre-populate `known_hosts` so SSH never needs to
modify the directory. Keep credentials outside the checkout or in ignored
files. The repository root `.dockerignore` is a second boundary that excludes
common configuration, key, secret, state, and environment-file paths from the
build context.

The container's `local` machine is the container itself, not the Docker host.
SSH, `tmux`, `screen`, Python, curl, and file-type detection are installed for
the bundled helpers. Host devices and host-local graphical capture are not
implicitly exposed. Local tmux/screen processes live inside the container and
do not survive container restart or recreation; durable sessions on remote SSH
hosts remain owned by those hosts and can be reattached.

## Operations

The image health check calls the unauthenticated `/api/health` endpoint on the
selected internal bind address, using HTTPS when native wmux TLS certificate
and key variables are present. Inspect it with `docker compose ps`.

To print the generated shared token or configure browser login credentials:

```bash
docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml exec wmux cat /home/node/.wmux/token
docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml exec wmux \
  node scripts/wmux-set-password --username you
```

Pull and restart when following a published tag:

```bash
WMUX_IMAGE=ghcr.io/gisenberg/wmux:0.1.2 \
  docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml pull
WMUX_IMAGE=ghcr.io/gisenberg/wmux:0.1.2 \
  docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml up -d --no-build
```

Rebuild and restart after updating a source checkout:

```bash
docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml up -d --build
```

Tagged releases also carry OCI source, version, revision, and license labels,
plus an SBOM and registry-backed build-provenance attestation. A Gitea Actions
mirror can copy the exact GHCR manifest using
`.gitea/workflows/release-container.yml`; configure the repository variables
`CONTAINER_REGISTRY` and `CONTAINER_USERNAME` and the `REGISTRY_TOKEN` secret
on that Gitea instance. The registry must use trusted HTTPS.
