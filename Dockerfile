FROM node:24-bookworm-slim AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY main.mjs server.mjs domain.mjs ./
COPY public/ ./public/
FROM base AS tested
COPY test/ ./test/
RUN npm test && touch /tmp/tests-passed
FROM base
COPY --from=tested /tmp/tests-passed /app/.tests-passed
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "main.mjs"]
