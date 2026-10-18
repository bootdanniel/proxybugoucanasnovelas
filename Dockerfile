FROM node:18-slim

# Instala curl, ca-certificates e o cloudflared
RUN apt-get update && apt-get install -y curl ca-certificates && \
    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "start.js"]
