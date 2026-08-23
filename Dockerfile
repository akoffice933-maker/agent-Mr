# Unified AI Ads Agent — web app (Next.js 16, App Router)
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# google-ads is an OPTIONAL dependency for production mode (gRPC client, heavy).
# For production deployment install it in the build stage:
# RUN npm i google-ads --no-audit --no-fund
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app ./
EXPOSE 3000
CMD ["sh", "-c", "npx drizzle-kit migrate && npm start"]
