# 零依賴，因此不需要 npm install，也不需要多階段建置。
# Node 24 原生剝離 TypeScript 型別，無建置步驟。
FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

# 以非 root 執行
USER node

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/server.ts"]
