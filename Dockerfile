FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "src/index.js"]
