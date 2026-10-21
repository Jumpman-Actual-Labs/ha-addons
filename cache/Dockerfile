ARG BUILD_FROM

# --- Panel bundle -----------------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Add-on image -----------------------------------------------------------
FROM $BUILD_FROM

WORKDIR /app
COPY backend/requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

COPY backend/cache_addon ./cache_addon
COPY --from=frontend /frontend/dist ./static
COPY rootfs /

RUN chmod a+x /etc/services.d/cache/run /etc/services.d/cache/finish
