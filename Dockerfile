FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ src/

RUN mkdir -p data/pdfs

EXPOSE 3000

CMD ["node", "src/server.js"]
