FROM alpine:3.20

ARG PB_VERSION=0.22.21

RUN apk add --no-cache ca-certificates unzip wget

WORKDIR /pb

RUN wget -q https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip \
    && unzip pocketbase_${PB_VERSION}_linux_amd64.zip \
    && rm pocketbase_${PB_VERSION}_linux_amd64.zip

# Migrations add the team_id field to the users collection on boot.
COPY pb_migrations /pb/pb_migrations

EXPOSE 8090

CMD ["./pocketbase", "serve", "--http=0.0.0.0:8090"]
