FROM node:22-alpine

WORKDIR /app

COPY server.js index.html budget.html ./

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

EXPOSE 8080

CMD ["node", "server.js"]
