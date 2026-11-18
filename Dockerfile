# --- build ---------------------------------------------------------------
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm prisma generate && pnpm build

# --- runtime -------------------------------------------------------------
FROM node:22-alpine
# Prisma's query engine needs OpenSSL on Alpine.
RUN apk add --no-cache openssl
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./

EXPOSE 3001

# Migrations run on boot so a deploy is a single step. migrate deploy only
# applies committed migrations — it never generates or resets anything.
CMD ["sh", "-c", "pnpm prisma migrate deploy && node dist/main.js"]
