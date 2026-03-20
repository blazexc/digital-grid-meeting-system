FROM node:22-alpine

WORKDIR /app

COPY package.json package.json
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=18080

EXPOSE 18080

CMD ["npm", "start"]
