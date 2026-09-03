FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install pnpm and dependencies
RUN corepack enable && corepack prepare pnpm@9 --activate
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build
RUN pnpm build

# Expose port
EXPOSE 3000

# Start
CMD ["node", "dist/index.js"]
