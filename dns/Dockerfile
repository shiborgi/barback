FROM golang:1.24.6-alpine3.22@sha256:c8c5f95d64aa79b6547f3b626eb84b16a7ce18a139e3e9ca19a8c078b85ba80d AS build
WORKDIR /src
COPY go.mod ./
COPY cmd/supervisor/main.go ./cmd/supervisor/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w -buildid=' -o /supervisor ./cmd/supervisor

FROM coredns/coredns:1.12.1@sha256:e8c262566636e6bc340ece6473b0eed193cad045384401529721ddbe6463d31c
COPY --from=build /supervisor /supervisor
COPY Corefile /etc/coredns/Corefile
EXPOSE 53/udp 53/tcp 8081/tcp 9153/tcp
ENTRYPOINT ["/supervisor"]
