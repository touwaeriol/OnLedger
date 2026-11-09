# syntax=docker/dockerfile:1

# ---------- 阶段 1：构建前端 ----------
FROM node:24-alpine AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

COPY package.json package-lock.json ./
# --ignore-scripts：跳过下载 Electron 的 postinstall。
# 锁文件若缺少当前平台（linux-musl）的原生绑定，则按已安装版本补装 rolldown / lightningcss 的 musl 绑定。
RUN npm ci --ignore-scripts \
 && case "$(node -p process.arch)" in \
      x64) ARCH=x64 ;; arm64) ARCH=arm64 ;; *) echo "unsupported arch: $(node -p process.arch)" >&2; exit 1 ;; \
    esac \
 && PKGS="" \
 && if ! node -e "require('@rolldown/binding-linux-${ARCH}-musl')" 2>/dev/null; then \
      PKGS="$PKGS @rolldown/binding-linux-${ARCH}-musl@$(node -p "require('./node_modules/rolldown/package.json').version")"; \
    fi \
 && if [ -f node_modules/lightningcss/package.json ] && ! node -e "require('lightningcss-linux-${ARCH}-musl')" 2>/dev/null; then \
      PKGS="$PKGS lightningcss-linux-${ARCH}-musl@$(node -p "require('./node_modules/lightningcss/package.json').version")"; \
    fi \
 && if [ -n "$PKGS" ]; then npm i --no-save --ignore-scripts $PKGS; fi

COPY index.html vite.config.js ./
COPY src ./src
RUN npx vite build

# ---------- 阶段 2：运行时 ----------
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

# 运行时不需要包管理器：删除以缩小攻击面；同时打上 Alpine 安全补丁
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* /root/.npm

# 文件归 root 所有、node 用户只读
COPY server/ ./server/
COPY electron/chains.js ./electron/chains.js
COPY electron/providers/ ./electron/providers/
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "server/server.js"]
