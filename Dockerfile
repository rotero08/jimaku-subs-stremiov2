# The addon has no runtime dependencies, so the image is Node plus the source.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=7000
WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

# The official image ships an unprivileged "node" user.
USER node
EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/server.js"]
