# Built once on the build machine for every platform: no runtime dependency has native code.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
EXPOSE 7007
HEALTHCHECK CMD wget -qO /dev/null http://127.0.0.1:${PORT:-7007}/manifest.json || exit 1
CMD ["node", "dist/server.js"]
