FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production --no-audit --no-fund

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8080 10000

CMD ["node", "server/server.js"]