# D-02 substrate sandbox image: node + bun + git + gh + sandbox-agent + claude-ultrathink.
# Built locally, never pushed. Only the base image is pulled; run the D-03 disk gate
# (df --output=avail -B1 / >= 10737418240) immediately before building.
#
#   docker buildx build --load \
#     --build-context ultrathink=/root/.claude/plugins/cache/ultrathink/ultrathink/0.3.0 \
#     -t substrate-sandbox:0.1 infra/sandbox
#
# Containers are started only by packages/host/src/sandbox-provider.ts (substrateDocker), which
# supplies Cmd ["server","--token",<token>,"--host","0.0.0.0","--port","3000","--no-telemetry"]
# after this ENTRYPOINT.
FROM node:24-bookworm-slim

ARG BUN_VERSION=1.4.0
ARG BUN_SHA256=2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452
ARG SANDBOX_AGENT_VERSION=0.4.2

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git ca-certificates curl unzip; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# bun from the official linux-x64 release zip, checksum pinned.
RUN set -eux; \
    curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"; \
    echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c -; \
    unzip -q /tmp/bun.zip -d /tmp/bun; \
    install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun; \
    ln -s /usr/local/bin/bun /usr/local/bin/bunx; \
    rm -rf /tmp/bun /tmp/bun.zip; \
    bun --version

# sandbox-agent: the npm package carries the SDK; the `sandbox-agent` command is the native
# binary from its @sandbox-agent/cli-linux-x64 dependency, linked onto PATH for the ENTRYPOINT.
RUN set -eux; \
    npm install -g --no-audit --no-fund "sandbox-agent@${SANDBOX_AGENT_VERSION}"; \
    bin="$(find "$(npm root -g)/sandbox-agent" -type f -path '*/@sandbox-agent/cli-linux-x64/bin/sandbox-agent')"; \
    test -n "$bin" && test "$(printf '%s\n' "$bin" | wc -l)" = 1; \
    chmod 0755 "$bin"; \
    ln -s "$bin" /usr/local/bin/sandbox-agent; \
    sandbox-agent --version; \
    npm cache clean --force

# claude-ultrathink plugin tree (no credentials live in it; they stay in /root/.config/ultrathink on
# the host). The excluded paths are the plugin checkout's local, gitignored state.
COPY --from=ultrathink --exclude=.claude --exclude=.planning --exclude=.hermes --exclude=issues --exclude=sessions --exclude=.github . /opt/claude-ultrathink

WORKDIR /work
EXPOSE 3000
ENTRYPOINT ["sandbox-agent"]
