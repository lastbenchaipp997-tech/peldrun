# syntax=docker/dockerfile:1
# PELDRUN frontend (Next.js standalone). Build context: repository root.
# The backend URL is baked into the build (Next.js rewrites are evaluated at build time).
# NOTE: `next build` downloads Google Fonts (next/font/google), so the build needs internet.

FROM node:22-slim AS deps
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY frontend/ ./
ARG PELDRUN_BACKEND_URL=http://backend:8088
ENV PELDRUN_STANDALONE=1 \
    PELDRUN_BACKEND_URL=$PELDRUN_BACKEND_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3088 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
EXPOSE 3088
CMD ["node", "server.js"]
