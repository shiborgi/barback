# Barback DNS Resolver

Build with `docker build -f dns/Dockerfile -t barback-dns:build-sha256-<content-digest> dns`.

Run it on the Barback NAT network *without* `--dns` so `/etc/resolv.conf` contains only the container runtime's upstream resolvers. Mount the reconciler-generated `/records` directory read-only. The reconciler runs the resolver as UID 0 so it can read owner-only state and bind port 53; it grants only `CAP_NET_BIND_SERVICE`. It contains atomically replaced `db.barback.internal` and `lease.json` files. Set `BARBACK_STACK_ID` and `BARBACK_DNS_GENERATION` to the active resolver identity.

CoreDNS listens on UDP and TCP 53 and exports bounded query/error metrics on port 9153. The supervisor exposes `GET /` on port 8081, returning `204` only while the accepted lease is valid and CoreDNS is running. Invalid, foreign, stale, or expired lease updates do not replace a valid lease; expiry stops CoreDNS until a later valid renewal is observed.
