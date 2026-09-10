FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

COPY package.json ./
RUN npm install --omit=dev

COPY server.js zip.js auth.js ./
COPY public ./public

RUN mkdir -p /data/files && chown -R node:node /app /data

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
