FROM node:20-alpine

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

ENV NODE_ENV=production

EXPOSE 3000

USER node

CMD ["node", "index.js"]
