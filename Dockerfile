FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate && npm install --global sfw@2.0.4
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN sfw pnpm install --frozen-lockfile
COPY index.html vite.config.mjs ./
COPY src ./src
COPY public ./public
COPY scripts/responsive-image-api.mjs ./scripts/responsive-image-api.mjs
RUN sfw pnpm build
RUN sfw pnpm prune --prod

FROM node:22.22.0-bookworm-slim AS runtime
ARG UID=1000
ARG GID=1000
WORKDIR /app
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates tini fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && test "$UID" -gt 0 && test "$GID" -gt 0 \
    && groupmod --non-unique --gid "$GID" node && usermod --non-unique --uid "$UID" --gid "$GID" node
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY package.json ./
COPY server ./server
COPY scripts ./scripts
RUN mkdir -p /app/data /app/state && chown -R node:node /app/data /app/state
ENV NODE_ENV=production PORT=3000 WARDROBE_STATE_DIR=/app/state
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.mjs"]
