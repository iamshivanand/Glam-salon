# Build + runtime image for the Glam Connect API.
# The runtime stage prunes dev dependencies and drops to a non-root user.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app
RUN addgroup -S glam && adduser -S glam -G glam

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Migrations and the seed live outside the compiled bundle.
COPY db ./db

USER glam
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are a separate one-off command:
#   docker run --rm --env-file .env <image> node dist/scripts/migrate.js
CMD ["node", "dist/src/index.js"]
