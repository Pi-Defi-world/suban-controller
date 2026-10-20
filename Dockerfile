FROM node:22-bookworm-slim

WORKDIR /app

# Copy package files. pnpm-workspace.yaml carries the allowed build scripts
# (better-sqlite3 ships a native addon).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install pnpm and dependencies
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
RUN pnpm install --frozen-lockfile

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build
RUN pnpm build

# Runtime
ENV NODE_ENV=production
EXPOSE 3000

# Price history lives here; mount a volume to survive container replacement.
VOLUME ["/app/data"]

CMD ["node", "dist/index.js"]
