# CPRI public website + API.
#
# Runs the full Node.js/Express back end (REST API + MySQL access + sessions).
# The static front end in public/ is served by this same container, so the site
# works standalone; it can equally be published separately on GitHub Pages, in
# which case set CORS_ORIGINS here and CPRI_API_BASE in public/assets/js/main.js.
#
# Build:  docker build -t cpri .
# Run:    docker run -p 3000:3000 --env-file .env cpri
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so the layer is reused while only source files change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Application code. Note that .env is deliberately NOT copied — it holds real
# credentials and must be supplied by the host's environment variables instead.
COPY server ./server
COPY public ./public

# Sessions and uploaded files are written under server/data at runtime. On hosts
# with ephemeral disks mount a volume there (e.g. /app/server/data) or logins and
# uploads will disappear on each restart or deploy.
RUN mkdir -p server/data/sessions

EXPOSE 3000

# Uses the JSON health endpoint; reports 503 when the database is unreachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]
