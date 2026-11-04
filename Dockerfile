# The system as one container, for an ordinary server (inside the Kingdom or on the customer's own
# machine). Only Node.js is needed; there are no packages to install. See deploy/ and the README.
FROM node:22-slim
WORKDIR /app
COPY server ./server
COPY src ./src
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=8787
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/api/bootstrap').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/node.mjs"]
