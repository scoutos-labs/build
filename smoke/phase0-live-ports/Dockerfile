FROM node:20-alpine

WORKDIR /app

COPY --chown=1000:1000 package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=1000:1000 . .

ENV NODE_ENV=production
ENV HOME=/home/node

EXPOSE 3000

# Numeric UID: the pod securityContext enforces runAsNonRoot, which K8s can
# only verify for numeric users.
USER 1000

CMD ["node", "index.js"]
