FROM node:22-alpine

RUN apk add --no-cache bash unzip zip rsync

WORKDIR /app

COPY package.json package.json
COPY server.js server.js

ENV PORT=8080
ENV UPLOADS_DIR=/data/uploads
ENV SITES_DIR=/data/sites
ENV TMP_DIR=/data/tmp

EXPOSE 8080

CMD ["node", "server.js"]
