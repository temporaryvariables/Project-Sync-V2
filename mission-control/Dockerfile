# Build the Vite SPA, then serve the static output with nginx.
FROM node:20-alpine AS build
WORKDIR /app

# Vite reads VITE_* variables at build time. Pass them as build args.
ARG VITE_POCKETBASE_URL
ARG VITE_GROUND_STATION_URL
ARG VITE_FLIGHT_DIRECTOR_URL
ARG VITE_DEEP_SPACE_NETWORK_URL
ENV VITE_POCKETBASE_URL=$VITE_POCKETBASE_URL
ENV VITE_GROUND_STATION_URL=$VITE_GROUND_STATION_URL
ENV VITE_FLIGHT_DIRECTOR_URL=$VITE_FLIGHT_DIRECTOR_URL
ENV VITE_DEEP_SPACE_NETWORK_URL=$VITE_DEEP_SPACE_NETWORK_URL

COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
