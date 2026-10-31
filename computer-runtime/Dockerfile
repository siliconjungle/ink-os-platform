FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /opt/ink-computer
COPY computer-runtime/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY computer-runtime/server.mjs ./server.mjs
ENV NODE_ENV=production PORT=8080
USER pwuser
CMD ["node","server.mjs"]
