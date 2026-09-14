# syntax=docker/dockerfile:1
# =============================================================================
# Raja1 — single image, process selected by $APP (api | scheduler | worker).
# Multi-stage: full toolchain builds the composite TypeScript project, the
# runtime ships pruned production dependencies + compiled dist as a non-root user.
# =============================================================================

FROM node:22-alpine AS build
WORKDIR /app

# .dockerignore keeps the context clean (no node_modules/dist/tests/docs/secrets).
COPY . .

# Install, build the composite project references, then drop dev dependencies so the
# runtime layer stays small. Workspace links (@raja/*) survive the prune (prod deps).
RUN npm ci --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev

# --------------------------------------------------------------------------- runtime ---
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S raja && adduser -S raja -G raja

# Compiled sources + pruned node_modules from the build stage.
COPY --from=build --chown=raja:raja /app /app

USER raja

# Which process this container runs: api (admin API + console) | scheduler | worker.
ENV APP=api
EXPOSE 3001

CMD ["sh", "-c", "\
  case \"$APP\" in \
    api)       export RAJA_BOOTSTRAP_ADMIN_API=1 ;; \
    scheduler) export RAJA_BOOTSTRAP_SCHEDULER=1 ;; \
    worker)    export RAJA_BOOTSTRAP_WORKER=1 ;; \
    *) echo \"unknown APP=$APP (use api|scheduler|worker)\" >&2; exit 64 ;; \
  esac; exec node \"apps/$APP/dist/index.js\""]
