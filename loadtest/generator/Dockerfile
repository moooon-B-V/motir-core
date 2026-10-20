# The load-test generator image (MOTIR-9116).
#
# The generator is the one Fly machine with a route to private staging, and the run command
# (`loadtest/run/generator.ts`) refuses it unless `/opt/loadtest/k6 version` answers with the pinned
# k6 and xk6-sse and a volume is mounted at `/data`. This image carries the binary at
# `/opt/loadtest/k6`; `fly.loadgen.toml` mounts the volume. Before this file the binary was placed
# on a machine by hand, and Fly resets a machine's root filesystem on restart.
#
# The pins are loadtest/k6/versions.env. `loadtest/generator/deploy.sh` passes them as build args, so
# a bump is made in one place; the defaults below are what a bare `docker build` uses, and
# tests/loadtest/generatorImage.test.ts fails when they drift from versions.env.
#
# The image sleeps. It runs nothing of its own: the run command starts the machine, uploads the k6
# tree and a run script over `fly ssh sftp`, and starts the script detached with `setsid nohup`.
ARG XK6_IMAGE_TAG=1.4.14

FROM --platform=linux/amd64 grafana/xk6:${XK6_IMAGE_TAG} AS k6
ARG K6_VERSION=v1.2.1
ARG XK6_SSE_MODULE=github.com/phymbert/xk6-sse
ARG XK6_SSE_VERSION=v0.1.12
USER root
RUN xk6 build "${K6_VERSION}" --with "${XK6_SSE_MODULE}@${XK6_SSE_VERSION}" \
      --os linux --arch amd64 --output /k6

FROM --platform=linux/amd64 debian:bookworm-slim
# sh, setsid (util-linux), nohup (coreutils) and nproc are what run.sh uses; curl is for checks by hand.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl util-linux \
 && rm -rf /var/lib/apt/lists/*
COPY --from=k6 /k6 /opt/loadtest/k6
# Fail the build, not the run, when the binary is not the SSE-capable one.
RUN /opt/loadtest/k6 version | grep -q xk6-sse
CMD ["sleep", "infinity"]
