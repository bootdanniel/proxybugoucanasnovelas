#!/bin/sh
# Inicia o proxy em background
node server.js &
# Inicia o túnel apontando para o proxy local
cloudflared tunnel --no-autoupdate --url http://localhost:3000
